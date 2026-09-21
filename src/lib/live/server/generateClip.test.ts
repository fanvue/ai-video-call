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
  anchorHasBody: true,
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

  it("on the reference backend (no end frame), skips extract/guard/repair too — its result frame is never reused as a seed", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: false, render });
    const req = clipRequest({ job: { kind: "idle" }, backend: "reference" });

    const result = await generateClip(req);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: undefined }),
    );
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
    expect(guardFrame).not.toHaveBeenCalled();
    expect(repairFrame).not.toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.loops).toBe(false);
    expect(result.seedFrameUrl).toBe(req.session.seedFrameUrl);
  });
});

describe("generateClip: chained jobs", () => {
  it("greeting chains forward from its real last frame instead of looping back to the anchor", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    const req = clipRequest({ job: { kind: "greeting" } });

    const result = await generateClip(req);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: undefined }),
    );
    expect(extractLastFrameUrl).toHaveBeenCalled();
    expect(guardFrame).toHaveBeenCalled();
    expect(result.loops).toBe(false);
    expect(result.seedFrameUrl).toBe("https://example.com/extracted.jpg");
  });

  it("a reply job extracts the last frame and guards it, and does not loop", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    writeReply.mockResolvedValue({ text: "mmm okay", nextWorld: "w" });
    const req = clipRequest({
      job: {
        kind: "reply",
        requestId: "r1",
        text: "take off your top",
        channel: "voice",
        from: "fan",
      },
    });

    const result = await generateClip(req);

    expect(extractLastFrameUrl).toHaveBeenCalledWith(
      "https://example.com/out.mp4",
      expect.any(Number),
    );
    expect(guardFrame).toHaveBeenCalled();
    expect(repairFrame).not.toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.loops).toBe(false);
  });

  it("a beat job (mid-chain) repairs a flagged frame, since its output seeds the next beat in the same sequence", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: ["top should be on but frame shows it off"],
    });
    repairFrame.mockResolvedValue("https://example.com/repaired.jpg");
    const req = clipRequest({
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          physical: "she stands up",
          durationSec: 15,
          nextState: { wardrobe: wardrobe(), body: body({ pose: "standing" }) },
        },
      },
    });

    const result = await generateClip(req);

    expect(extractLastFrameUrl).toHaveBeenCalled();
    expect(guardFrame).toHaveBeenCalled();
    expect(repairFrame).toHaveBeenCalled();
    expect(result.guard.checked).toBe(true);
    expect(result.guard.repaired).toBe(true);
    expect(result.guard.issues).toEqual([
      "top should be on but frame shows it off",
    ]);
    expect(result.seedFrameUrl).toBe("https://example.com/repaired.jpg");
  });

  it("a beat job whose plan is a no-op hold still renders without an end frame and goes through extract/guard — pinning never stopped mid-clip drift, only the prompt itself can", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    const req = clipRequest({
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          physical: "she chats, nothing changes",
          durationSec: 15,
          nextState: { wardrobe: wardrobe(), body: body() },
        },
      },
    });

    const result = await generateClip(req);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: undefined }),
    );
    expect(extractLastFrameUrl).toHaveBeenCalled();
    expect(guardFrame).toHaveBeenCalled();
    expect(repairFrame).not.toHaveBeenCalled();
    expect(result.loops).toBe(false);
  });

  it("a reply job whose plan changes state (not a no-op) still renders without an end frame and goes through extract/guard", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    writeReply.mockResolvedValue({ text: "mmm okay", nextWorld: "w" });
    const req = clipRequest({
      job: {
        kind: "reply",
        requestId: "r1",
        text: "take off your top",
        channel: "voice",
        from: "fan",
      },
    });

    const result = await generateClip(req);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: undefined }),
    );
    expect(extractLastFrameUrl).toHaveBeenCalled();
    expect(guardFrame).toHaveBeenCalled();
    expect(result.loops).toBe(false);
  });

  it("a settle job (ends the chain) runs the guard", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    const req = clipRequest({ job: { kind: "settle" } });

    await generateClip(req);

    expect(guardFrame).toHaveBeenCalled();
  });

  it("skips the periodic identity correction on a clip the guard already repaired", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: ["top should be on but frame shows it off"],
    });
    repairFrame.mockResolvedValue("https://example.com/repaired.jpg");
    // elapsedSec 40 + a 15s clip crosses the 45s identity-anchor cadence, so correction would
    // otherwise be due this clip. settle ends the chain, so it runs the full guard.
    const req = clipRequest({
      job: { kind: "settle" },
      session: session({ elapsedSec: 40 }),
    });

    const result = await generateClip(req);

    expect(repairFrame).toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.guard.repaired).toBe(true);
    expect(result.seedFrameUrl).toBe("https://example.com/repaired.jpg");
  });

  it("never runs blind periodic identity correction on either backend, even at a long elapsed time — only issue-scoped repairFrame can touch the seed", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    const req = clipRequest({
      job: { kind: "settle" },
      session: session({ elapsedSec: 400 }),
    });

    const result = await generateClip(req);

    expect(guardFrame).toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe("https://example.com/extracted.jpg");
  });

  it("never runs blind periodic identity correction on the reference backend either", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: false, render });
    const req = clipRequest({
      job: { kind: "settle" },
      backend: "reference",
      session: session({ elapsedSec: 400 }),
    });

    const result = await generateClip(req);

    expect(guardFrame).toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe("https://example.com/extracted.jpg");
  });
});
