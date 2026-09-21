import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_TUNABLES,
  type ClipRequest,
  type LiveSessionSnapshot,
} from "../contract";

const render = vi.fn();
vi.mock("./renderClip", () => ({
  renderBackendFor: () => ({ render, supportsEndFrame: true }),
}));

const extractLastFrameUrl = vi.fn();
const extractMidFrameUrl = vi.fn();
vi.mock("@/lib/fal/extractLastFrame", () => ({
  extractLastFrameUrl: (...args: unknown[]) => extractLastFrameUrl(...args),
  extractMidFrameUrl: (...args: unknown[]) => extractMidFrameUrl(...args),
}));

const guardFrame = vi.fn();
vi.mock("./frameGuard", () => ({
  guardFrame: (...args: unknown[]) => guardFrame(...args),
}));

vi.mock("./writeReply", () => ({
  writeReply: vi.fn(async () => ({ text: "hey you", nextWorld: "chatting" })),
  writeCheckIn: vi.fn(async () => null),
}));

const { generateClip } = await import("./generateClip");

const session: LiveSessionSnapshot = {
  creator: {
    id: "creator-1",
    displayName: "Aria",
    lookLock: "long dark hair, olive skin, athletic build",
    sceneId: "bedroom",
    tipMenu: [],
  },
  state: {
    wardrobe: {
      top: { on: false, description: "top" },
      bottom: { on: false, description: "bottoms" },
      bra: { on: true, description: "white bra" },
      panties: { on: true, description: "white panties" },
      removedOrder: [],
    },
    body: {
      pose: "sitting",
      facing: "camera",
      hands: "free",
      contact: "none",
      prop: "none",
      framing: "wider",
    },
    baselineBody: {
      pose: "sitting",
      facing: "camera",
      hands: "free",
      contact: "none",
      prop: "none",
      framing: "wider",
    },
    world: "quiet evening",
    surroundings: "bedroom desk with a laptop webcam",
  },
  seedFrameUrl: "https://example.com/seed.jpg",
  anchorFrameUrl: "https://example.com/anchor.jpg",
  elapsedSec: 10,
  transcript: [],
};

const request = (
  job: ClipRequest["job"],
  useIdentityReference = false,
): ClipRequest => ({
  session,
  job,
  backend: "turbo",
  speechMode: "text",
  useIdentityReference,
});

beforeEach(() => {
  render.mockReset();
  extractLastFrameUrl.mockReset();
  extractMidFrameUrl.mockReset();
  guardFrame.mockReset();
  render.mockResolvedValue({
    videoUrl: "https://example.com/clip.mp4",
    costUsd: 0.275,
  });
  extractLastFrameUrl.mockResolvedValue("https://example.com/last.jpg");
});

describe("generateClip with the vision guard off (default)", () => {
  it("is the default", () => {
    expect(LIVE_TUNABLES.VERIFY_FRAMES).toBe(false);
  });

  it("greeting: extracts only the last frame as the next seed, never calls vision, approves with the planned state", async () => {
    const result = await generateClip(request({ kind: "greeting" }));
    expect(result.verdict).toBe("approved");
    expect(result.seedFrameUrl).toBe("https://example.com/last.jpg");
    expect(extractLastFrameUrl).toHaveBeenCalledTimes(1);
    expect(extractMidFrameUrl).not.toHaveBeenCalled();
    expect(guardFrame).not.toHaveBeenCalled();
    expect(result.guard.checked).toBe(false);
    expect(result.state.wardrobe.bra.on).toBe(true);
  });

  it("idle: no extraction at all, plays from the session seed", async () => {
    const result = await generateClip(request({ kind: "idle" }));
    expect(result.verdict).toBe("approved");
    expect(result.seedFrameUrl).toBe(session.seedFrameUrl);
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
    expect(guardFrame).not.toHaveBeenCalled();
  });

  it("wardrobe beat: adopts the planned wardrobe without observing it", async () => {
    const result = await generateClip(
      request({
        kind: "beat",
        beat: {
          id: "b1",
          intent: { type: "removeGarment", garment: "bra" },
          attempt: 0,
        },
      }),
    );
    expect(result.verdict).toBe("approved");
    expect(result.state.wardrobe.bra.on).toBe(false);
    expect(guardFrame).not.toHaveBeenCalled();
  });

  it("still rejects when the last frame cannot be extracted, since the next clip would have no seed", async () => {
    extractLastFrameUrl.mockRejectedValue(new Error("fal down"));
    const result = await generateClip(request({ kind: "greeting" }));
    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toMatch(/extraction failed/);
    expect(result.seedFrameUrl).toBe(session.seedFrameUrl);
  });

  it("only forwards identityReferenceUrl to the backend when useIdentityReference is set", async () => {
    await generateClip(request({ kind: "idle" }, false));
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ identityReferenceUrl: undefined }),
    );

    render.mockClear();
    await generateClip(request({ kind: "idle" }, true));
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ identityReferenceUrl: session.anchorFrameUrl }),
    );
  });
});
