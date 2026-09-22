import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_TUNABLES,
  type ClipRequest,
  type LiveSessionSnapshot,
} from "../contract";

const render = vi.fn();
const renderBackendFor = vi.fn(() => ({ render, supportsEndFrame: true }));
vi.mock("./renderClip", () => ({
  renderBackendFor: (...args: unknown[]) =>
    (renderBackendFor as (...a: unknown[]) => unknown)(...args),
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

const swapClip = vi.fn();
const swapTail = vi.fn();
// Fully mocked: the real module pulls in @/env, which validates the server environment at import.
vi.mock("./swapClip", () => ({
  SWAP_BUDGET_MS: 150_000,
  SWAP_GREETING_BUDGET_MS: 20_000,
  swapClip: (...args: unknown[]) => swapClip(...args),
  swapTail: (...args: unknown[]) => swapTail(...args),
  pendingSwapReport: () => ({
    status: "pending",
    swapMs: 0,
    frames: 0,
    framesWithFace: 0,
    msPerFrame: 0,
    similarityBefore: null,
    similarityAfter: null,
    restored: false,
    reason: null,
  }),
  failedSwapReport: (swapMs: number, error: Error) => ({
    status: "failed",
    swapMs,
    frames: 0,
    framesWithFace: 0,
    msPerFrame: 0,
    similarityBefore: null,
    similarityAfter: null,
    restored: false,
    reason: error.message,
  }),
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
  swapClip.mockReset();
  swapTail.mockReset();
  extractLastFrameUrl.mockReset();
  extractMidFrameUrl.mockReset();
  guardFrame.mockReset();
  render.mockResolvedValue({
    videoUrl: "https://example.com/clip.mp4",
    costUsd: 0.275,
  });
  extractLastFrameUrl.mockResolvedValue("https://example.com/last.jpg");
});

// Two-phase swap (LIVE_TUNABLES.SWAP_DEFER_CLIP, the default): the render call swaps only the tail and returns the clip pending, so the chain moves on while the client finishes the swap.
describe("generateClip on the swap backend with the deferred clip swap", () => {
  const swapRequest = (job: ClipRequest["job"]): ClipRequest => ({
    ...request(job),
    backend: "swap",
  });

  it("is the default", () => {
    expect(LIVE_TUNABLES.SWAP_DEFER_CLIP).toBe(true);
  });

  it("a chain clip swaps only its tail, seeds the next clip from it and comes back unswapped with a pending report", async () => {
    swapTail.mockResolvedValue({
      lastFrameUrl: "https://example.com/tail.jpg",
      costUsd: 0.001,
    });
    const result = await generateClip(
      swapRequest({
        kind: "reply",
        requestId: "r1",
        text: "hi",
        channel: "chat",
        from: "fan",
        precededByIdle: false,
      }),
    );
    expect(swapClip).not.toHaveBeenCalled();
    expect(swapTail).toHaveBeenCalledWith({
      videoUrl: "https://example.com/clip.mp4",
      referenceImageUrl: session.anchorFrameUrl,
      jobKind: "reply",
    });
    expect(result.videoUrl).toBe("https://example.com/clip.mp4");
    expect(result.seedFrameUrl).toBe("https://example.com/tail.jpg");
    expect(result.swap?.status).toBe("pending");
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
  });

  it("an idle needs no tail at all: it loops back to its seed and only its clip swap is pending", async () => {
    const result = await generateClip(swapRequest({ kind: "idle" }));
    expect(swapTail).not.toHaveBeenCalled();
    expect(swapClip).not.toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe(session.seedFrameUrl);
    expect(result.swap?.status).toBe("pending");
  });

  it("falls back to the raw last frame as the seed when the tail swap fails, still leaving the clip swap pending", async () => {
    swapTail.mockRejectedValue(new Error("Swap service responded 503"));
    const result = await generateClip(
      swapRequest({ kind: "checkIn", channel: "chat" }),
    );
    expect(result.verdict).toBe("approved");
    expect(result.seedFrameUrl).toBe("https://example.com/last.jpg");
    expect(result.swap?.status).toBe("pending");
  });

  it("never touches the swap service on other backends", async () => {
    await generateClip(request({ kind: "greeting" }));
    expect(swapTail).not.toHaveBeenCalled();
    expect(swapClip).not.toHaveBeenCalled();
  });
});
