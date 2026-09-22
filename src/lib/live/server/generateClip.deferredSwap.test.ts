import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_TUNABLES,
  stateFrameKey,
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
const swapServiceLastFrame = vi.fn();
// Fully mocked: the real module pulls in @/env, which validates the server environment at import.
vi.mock("./swapClip", () => ({
  SWAP_BUDGET_MS: 150_000,
  SWAP_GREETING_BUDGET_MS: 20_000,
  swapClip: (...args: unknown[]) => swapClip(...args),
  swapServiceLastFrame: (...args: unknown[]) => swapServiceLastFrame(...args),
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
  swapServiceLastFrame.mockReset();
  swapServiceLastFrame.mockResolvedValue("https://example.com/tail-raw.jpg");
  extractLastFrameUrl.mockReset();
  extractMidFrameUrl.mockReset();
  guardFrame.mockReset();
  render.mockResolvedValue({
    videoUrl: "https://example.com/clip.mp4",
    costUsd: 0.275,
  });
  extractLastFrameUrl.mockResolvedValue("https://example.com/last.jpg");
});

// Two-phase swap (LIVE_TUNABLES.SWAP_DEFER_CLIP, the default): the render call returns the clip pending and seeds the next clip from the raw render, so the chain moves on while the client finishes the swap.
describe("generateClip on the swap backend with the deferred clip swap", () => {
  const swapRequest = (job: ClipRequest["job"]): ClipRequest => ({
    ...request(job),
    backend: "swap",
  });

  it("is the default", () => {
    expect(LIVE_TUNABLES.SWAP_DEFER_CLIP).toBe(true);
  });

  const replyRequest = () =>
    swapRequest({
      kind: "reply",
      requestId: "r1",
      text: "hi",
      channel: "chat",
      from: "fan",
      precededByIdle: false,
    });

  it("a reply swaps inline from the raw clip while its seed decodes, and comes back already swapped", async () => {
    swapClip.mockResolvedValue({
      videoUrl: "https://example.com/swapped.mp4",
      lastFrameUrl: "https://example.com/swapped-last.jpg",
      report: { status: "swapped", swapMs: 3000 },
      costUsd: 0.01,
    });
    const result = await generateClip(replyRequest());
    expect(swapClip).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: "https://example.com/clip.mp4" }),
    );
    expect(swapServiceLastFrame).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: "https://example.com/clip.mp4" }),
    );
    expect(result.videoUrl).toBe("https://example.com/swapped.mp4");
    expect(result.seedFrameUrl).toBe("https://example.com/tail-raw.jpg");
    expect(result.swap?.status).toBe("swapped");
  });

  it("a reply whose inline swap fails comes back raw and pending so the client swap still runs", async () => {
    swapClip.mockRejectedValue(new Error("Swap service responded 408"));
    const result = await generateClip(replyRequest());
    expect(result.videoUrl).toBe("https://example.com/clip.mp4");
    expect(result.seedFrameUrl).toBe("https://example.com/tail-raw.jpg");
    expect(result.swap?.status).toBe("pending");
  });

  it("a chain clip seeds the next clip from its raw last frame and comes back unswapped with a pending report", async () => {
    const result = await generateClip(
      swapRequest({ kind: "checkIn", channel: "chat" }),
    );
    expect(swapClip).not.toHaveBeenCalled();
    expect(swapServiceLastFrame).toHaveBeenCalledWith({
      videoUrl: "https://example.com/clip.mp4",
    });
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
    expect(result.videoUrl).toBe("https://example.com/clip.mp4");
    expect(result.seedFrameUrl).toBe("https://example.com/tail-raw.jpg");
    expect(result.swap?.status).toBe("pending");
  });

  it("falls back to fal's frame extraction for the seed when the swap service cannot decode the tail", async () => {
    swapServiceLastFrame.mockRejectedValue(
      new Error("Swap service responded 503"),
    );
    const result = await generateClip(
      swapRequest({ kind: "checkIn", channel: "chat" }),
    );
    expect(result.verdict).toBe("approved");
    expect(result.seedFrameUrl).toBe("https://example.com/last.jpg");
    expect(result.swap?.status).toBe("pending");
  });

  it("an idle loops back to its seed and only its clip swap is pending", async () => {
    const result = await generateClip(swapRequest({ kind: "idle" }));
    expect(swapClip).not.toHaveBeenCalled();
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe(session.seedFrameUrl);
    expect(result.swap?.status).toBe("pending");
  });

  it("a chain clip landing in a banked state ends on that frame and seeds from it without a tail decode", async () => {
    const banked = "https://example.com/banked-sitting.png";
    const result = await generateClip({
      ...swapRequest({ kind: "checkIn", channel: "chat" }),
      session: {
        ...session,
        stateFrames: { [stateFrameKey(session.state)]: banked },
      },
    });
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        seedFrameUrl: session.seedFrameUrl,
        endFrameUrl: banked,
      }),
    );
    expect(swapServiceLastFrame).not.toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe(banked);
  });

  it("a chain clip into a state not banked yet chains from its own last frame", async () => {
    const result = await generateClip({
      ...swapRequest({ kind: "checkIn", channel: "chat" }),
      session: {
        ...session,
        stateFrames: { "some|other|state": "https://example.com/other.png" },
      },
    });
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: undefined }),
    );
    expect(result.seedFrameUrl).toBe("https://example.com/tail-raw.jpg");
  });

  it("never touches the swap service on other backends", async () => {
    await generateClip(request({ kind: "greeting" }));
    expect(swapClip).not.toHaveBeenCalled();
  });
});
