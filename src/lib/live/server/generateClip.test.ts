import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Body,
  ClipRequest,
  CreatorProfile,
  LiveSessionSnapshot,
  LiveState,
  Wardrobe,
} from "../contract";

const render = vi.fn();
const renderBackendFor = vi.fn();
vi.mock("./renderClip", () => ({
  renderBackendFor: (...args: unknown[]) => renderBackendFor(...args),
}));

const extractLastFrameUrl = vi.fn();
vi.mock("@/lib/fal/extractLastFrame", () => ({
  extractLastFrameUrl: (...args: unknown[]) => extractLastFrameUrl(...args),
}));

const correctFrameIdentityDrift = vi.fn();
vi.mock("@/lib/fal/requestFrameIdentityCorrection", () => ({
  correctFrameIdentityDrift: (...args: unknown[]) =>
    correctFrameIdentityDrift(...args),
}));

const guardFrame = vi.fn();
const repairFrame = vi.fn();
vi.mock("./frameGuard", () => ({
  guardFrame: (...args: unknown[]) => guardFrame(...args),
  repairFrame: (...args: unknown[]) => repairFrame(...args),
}));

const writeReply = vi.fn();
const writeCheckIn = vi.fn();
vi.mock("./writeReply", () => ({
  writeReply: (...args: unknown[]) => writeReply(...args),
  writeCheckIn: (...args: unknown[]) => writeCheckIn(...args),
}));

const { generateClip } = await import("./generateClip");

const wardrobe = (overrides: Partial<Wardrobe> = {}): Wardrobe => ({
  top: { on: true, description: "black ribbed tank top" },
  bottom: { on: true, description: "denim shorts" },
  bra: { on: true, description: "black lace bra" },
  panties: { on: true, description: "black lace panties" },
  removedOrder: [],
  ...overrides,
});

const body = (overrides: Partial<Body> = {}): Body => ({
  pose: "sitting",
  facing: "camera",
  hands: "free",
  contact: "none",
  prop: "none",
  framing: "wider",
  ...overrides,
});

const creator: CreatorProfile = {
  id: "creator-1",
  displayName: "Aria",
  lookLock: "long dark hair, olive skin, athletic build",
  sceneId: "bedroom",
  tipMenu: [],
};

const state = (overrides: Partial<LiveState> = {}): LiveState => ({
  wardrobe: wardrobe(),
  body: body(),
  baselineBody: body(),
  world: "quiet evening, laptop propped on the desk",
  surroundings: "bedroom desk with a laptop webcam",
  ...overrides,
});

const session = (
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot => ({
  creator,
  state: state(),
  seedFrameUrl: "https://example.com/seed.jpg",
  anchorFrameUrl: "https://example.com/anchor.jpg",
  elapsedSec: 10,
  transcript: [],
  ...overrides,
});

const clipRequest = (overrides: Partial<ClipRequest> = {}): ClipRequest => ({
  session: session(),
  job: { kind: "idle" },
  backend: "turbo",
  speechMode: "text",
  ...overrides,
});

beforeEach(() => {
  render.mockReset();
  renderBackendFor.mockReset();
  extractLastFrameUrl.mockReset();
  correctFrameIdentityDrift.mockReset();
  guardFrame.mockReset();
  repairFrame.mockReset();
  writeReply.mockReset();
  writeCheckIn.mockReset();

  render.mockResolvedValue({
    videoUrl: "https://example.com/out.mp4",
    costUsd: 0.25,
  });
  guardFrame.mockResolvedValue({ checked: false, issues: [] });
  extractLastFrameUrl.mockResolvedValue("https://example.com/extracted.jpg");
});

describe("generateClip: anchored idle loop", () => {
  it("on a backend with an end frame, passes the anchor as both seed and end frame and skips extract/guard/repair", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    const req = clipRequest({ job: { kind: "idle" } });

    const result = await generateClip(req);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        seedFrameUrl: req.session.seedFrameUrl,
        endFrameUrl: req.session.seedFrameUrl,
      }),
    );
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
    expect(guardFrame).not.toHaveBeenCalled();
    expect(repairFrame).not.toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.loops).toBe(true);
    expect(result.seedFrameUrl).toBe(req.session.seedFrameUrl);
    expect(result.timings.frameMs).toBe(0);
    expect(result.timings.guardMs).toBe(0);
    expect(result.timings.repairMs).toBe(0);
  });

  it("on the reference backend (no end frame), falls back to the chained path", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: false, render });
    const req = clipRequest({ job: { kind: "idle" }, backend: "reference" });

    const result = await generateClip(req);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: undefined }),
    );
    expect(extractLastFrameUrl).toHaveBeenCalled();
    expect(guardFrame).toHaveBeenCalled();
    expect(result.loops).toBe(false);
  });
});

describe("generateClip: chained jobs", () => {
  it("a reply job extracts the last frame and runs the guard, and does not loop", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    writeReply.mockResolvedValue({ text: "mmm okay", nextWorld: "w" });
    const req = clipRequest({
      job: {
        kind: "reply",
        requestId: "r1",
        text: "wave at me",
        channel: "voice",
      },
    });

    const result = await generateClip(req);

    expect(extractLastFrameUrl).toHaveBeenCalledWith(
      "https://example.com/out.mp4",
      expect.any(Number),
    );
    expect(guardFrame).toHaveBeenCalled();
    expect(result.loops).toBe(false);
  });

  it("skips the periodic identity correction on a clip the guard already repaired", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: ["top should be on but frame shows it off"],
    });
    repairFrame.mockResolvedValue("https://example.com/repaired.jpg");
    // elapsedSec 40 + an 8s clip crosses the 45s identity-anchor cadence, so correction would
    // otherwise be due this clip.
    const req = clipRequest({
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          physical: "she waves",
          durationSec: 10,
          nextState: { wardrobe: wardrobe(), body: body() },
        },
      },
      session: session({ elapsedSec: 40 }),
    });

    const result = await generateClip(req);

    expect(repairFrame).toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.guard.repaired).toBe(true);
    expect(result.seedFrameUrl).toBe("https://example.com/repaired.jpg");
  });
});
