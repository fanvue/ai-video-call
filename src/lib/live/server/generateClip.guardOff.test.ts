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
// Fully mocked: the real module pulls in @/env, which validates the server environment at import.
vi.mock("./swapClip", () => ({
  SWAP_BUDGET_MS: 150_000,
  SWAP_GREETING_BUDGET_MS: 40_000,
  swapClip: (...args: unknown[]) => swapClip(...args),
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

  it("checkIn: extracts only the last frame as the next seed, never calls vision, approves with the planned state", async () => {
    const result = await generateClip(
      request({ kind: "checkIn", channel: "chat" }),
    );
    expect(result.verdict).toBe("approved");
    expect(result.seedFrameUrl).toBe("https://example.com/last.jpg");
    expect(extractLastFrameUrl).toHaveBeenCalledTimes(1);
    expect(extractMidFrameUrl).not.toHaveBeenCalled();
    expect(guardFrame).not.toHaveBeenCalled();
    expect(result.guard.checked).toBe(false);
    expect(result.state.wardrobe.bra.on).toBe(true);
  });

  it("greeting: loops on a staged seed (seed differs from the identity photo), no frame extraction", async () => {
    const result = await generateClip(request({ kind: "greeting" }));
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: session.seedFrameUrl }),
    );
    expect(result.loops).toBe(true);
    expect(result.seedFrameUrl).toBe(session.seedFrameUrl);
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
  });

  it("greeting: chains off a raw upload seed (seed is the identity photo), last frame becomes the seed", async () => {
    const result = await generateClip({
      ...request({ kind: "greeting" }),
      session: { ...session, seedFrameUrl: session.anchorFrameUrl },
    });
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: undefined }),
    );
    expect(result.loops).toBe(false);
    expect(result.seedFrameUrl).toBe("https://example.com/last.jpg");
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
    const result = await generateClip(
      request({ kind: "checkIn", channel: "chat" }),
    );
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

describe("generateClip on the swap backend", () => {
  const swapRequest = (job: ClipRequest["job"]): ClipRequest => ({
    ...request(job),
    backend: "swap",
  });
  const swapped = {
    videoUrl: "https://example.com/swapped.mp4",
    lastFrameUrl: "https://example.com/swapped-last.jpg",
    costUsd: 0.004,
    report: {
      status: "swapped" as const,
      swapMs: 12_000,
      frames: 240,
      framesWithFace: 240,
      msPerFrame: 50,
      similarityBefore: 0.3,
      similarityAfter: 0.7,
      restored: true,
      reason: null,
    },
  };

  it("plays the swapped clip, seeds the next clip from its swapped last frame without a fal extract, and adds the GPU cost", async () => {
    swapClip.mockResolvedValue(swapped);
    const result = await generateClip(
      swapRequest({ kind: "checkIn", channel: "chat" }),
    );
    expect(swapClip).toHaveBeenCalledWith({
      videoUrl: "https://example.com/clip.mp4",
      referenceImageUrl: session.anchorFrameUrl,
      budgetMs: 150_000,
      jobKind: "checkIn",
    });
    expect(result.videoUrl).toBe("https://example.com/swapped.mp4");
    expect(result.seedFrameUrl).toBe("https://example.com/swapped-last.jpg");
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
    expect(result.costUsd).toBeCloseTo(0.279, 6);
    expect(result.swap?.status).toBe("swapped");
  });

  it("gives the greeting only the short swap budget and, off a raw upload, seeds the next clip from its swapped last frame", async () => {
    swapClip.mockResolvedValue(swapped);
    const result = await generateClip({
      ...swapRequest({ kind: "greeting" }),
      session: { ...session, seedFrameUrl: session.anchorFrameUrl },
    });
    expect(swapClip.mock.calls[0][0].budgetMs).toBe(40_000);
    expect(result.videoUrl).toBe("https://example.com/swapped.mp4");
    expect(result.loops).toBe(false);
    expect(result.seedFrameUrl).toBe("https://example.com/swapped-last.jpg");
  });

  it("renders a raw-upload swap greeting through reference-to-video with the upload pinned to identity and the scene set by the prompt", async () => {
    swapClip.mockResolvedValue(swapped);
    await generateClip({
      ...swapRequest({ kind: "greeting" }),
      session: { ...session, seedFrameUrl: session.anchorFrameUrl },
    });
    expect(renderBackendFor).toHaveBeenLastCalledWith("swap", {
      greetingFromReference: true,
    });
    const prompt = render.mock.calls.at(-1)?.[0].prompt as string;
    expect(prompt).toMatch(/^Image 1 is the woman's identity only/);
    expect(prompt).toMatch(/bed/);
  });

  it("keeps a staged-seed swap greeting and every later swap clip on turbo", async () => {
    swapClip.mockResolvedValue(swapped);
    await generateClip(swapRequest({ kind: "greeting" }));
    expect(renderBackendFor).toHaveBeenLastCalledWith("swap", {
      greetingFromReference: false,
    });
    await generateClip(swapRequest({ kind: "idle" }));
    expect(renderBackendFor).toHaveBeenLastCalledWith("swap", {
      greetingFromReference: false,
    });
  });

  it("a staged-seed greeting in swap mode loops and plays from the staged still", async () => {
    swapClip.mockResolvedValue(swapped);
    const result = await generateClip(swapRequest({ kind: "greeting" }));
    expect(result.videoUrl).toBe("https://example.com/swapped.mp4");
    expect(result.loops).toBe(true);
    expect(result.seedFrameUrl).toBe(session.seedFrameUrl);
  });

  it("idle clips are swapped too, with the full budget, but still play from the session seed", async () => {
    swapClip.mockResolvedValue(swapped);
    const result = await generateClip(swapRequest({ kind: "idle" }));
    expect(result.videoUrl).toBe("https://example.com/swapped.mp4");
    expect(result.seedFrameUrl).toBe(session.seedFrameUrl);
    expect(swapClip.mock.calls[0][0].budgetMs).toBe(150_000);
  });

  it("falls back to the unswapped clip and the fal last frame when the service fails, reporting the reason", async () => {
    swapClip.mockRejectedValue(new Error("Swap service responded 503"));
    const result = await generateClip(
      swapRequest({ kind: "checkIn", channel: "chat" }),
    );
    expect(result.verdict).toBe("approved");
    expect(result.videoUrl).toBe("https://example.com/clip.mp4");
    expect(result.seedFrameUrl).toBe("https://example.com/last.jpg");
    expect(result.costUsd).toBe(0.275);
    expect(result.swap).toMatchObject({
      status: "failed",
      reason: "Swap service responded 503",
    });
  });

  it("never touches the swap service on other backends", async () => {
    await generateClip(request({ kind: "greeting" }));
    expect(swapClip).not.toHaveBeenCalled();
  });
});
