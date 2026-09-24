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
vi.mock("@/lib/fal/extractLastFrame", () => ({
  extractLastFrameUrl: (...args: unknown[]) => extractLastFrameUrl(...args),
  extractMidFrameUrl: vi.fn(),
}));

vi.mock("./frameGuard", () => ({ guardFrame: vi.fn() }));

const wan14bClip = vi.fn();
vi.mock("./wan14bClip", () => ({
  wan14bClip: (...args: unknown[]) => wan14bClip(...args),
}));

const swapClip = vi.fn();
const swapServiceLastFrame = vi.fn();
const swapTail = vi.fn();
// Fully mocked: the real module pulls in @/env, which validates the server environment at import.
vi.mock("./swapClip", () => ({
  SWAP_BUDGET_MS: 150_000,
  swapGreetingBudgetMsFor: () => 20_000,
  swapFailureReason: (error: unknown) =>
    error instanceof DOMException && error.name === "TimeoutError"
      ? "timeout"
      : "error",
  swapClip: (...args: unknown[]) => swapClip(...args),
  swapServiceLastFrame: (...args: unknown[]) => swapServiceLastFrame(...args),
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
  failedSwapReport: vi.fn(),
}));

vi.mock("./captureRoom", () => ({ captureRoom: vi.fn(async () => null) }));
vi.mock("./parseIntents", () => ({
  parseIntentsWithLlm: vi.fn(async () => null),
}));
const writeReply = vi.fn(async () => ({
  text: "hey you",
  nextWorld: "chatting",
}));
vi.mock("./writeReply", () => ({
  writeReply: (...args: unknown[]) =>
    (writeReply as (...a: unknown[]) => unknown)(...args),
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
      top: { on: true, description: "grey sweater" },
      bottom: { on: true, description: "blue jeans" },
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
  seedFrameUrl: "https://example.com/seed.png",
  anchorFrameUrl: "https://example.com/anchor.jpg",
  toneFrameUrl: "https://example.com/tone.png",
  elapsedSec: 10,
  transcript: [],
};

const reply: ClipRequest["job"] = {
  kind: "reply",
  requestId: "r1",
  text: "wave at me",
  channel: "chat",
  from: "fan",
  precededByIdle: false,
};

const premiumRequest = (
  job: ClipRequest["job"],
  overrides: Partial<ClipRequest> = {},
): ClipRequest => ({
  session,
  job,
  backend: "wan14b",
  speechMode: "text",
  personaId: "synth-persona-01",
  useIdentityReference: false,
  ...overrides,
});

const wanOutcome = {
  videoUrl: "https://example.com/wan.mp4",
  lastFrameUrl: "https://example.com/wan-last.png",
  report: {
    status: "swapped" as const,
    swapMs: 1_200,
    frames: 81,
    framesWithFace: 81,
    msPerFrame: 1_200 / 81,
    similarityBefore: null,
    similarityAfter: 0.81,
    restored: false,
    reason: null,
    fps: 16,
  },
  costUsd: 0.018,
  totalMs: 16_000,
};

beforeEach(() => {
  render.mockReset();
  render.mockResolvedValue({
    videoUrl: "https://example.com/turbo.mp4",
    costUsd: 0.25,
  });
  renderBackendFor.mockClear();
  wan14bClip.mockReset();
  swapClip.mockReset();
  swapTail.mockReset();
  swapTail.mockResolvedValue({
    lastFrameUrl: "https://example.com/tail.png",
    costUsd: 0.001,
  });
  swapServiceLastFrame.mockReset();
  extractLastFrameUrl.mockReset();
  writeReply.mockClear();
});

describe("generateClip on the Premium (wan14b) backend", () => {
  it("renders a chain clip through the Wan service from the session seed and seeds the next clip from its last frame", async () => {
    wan14bClip.mockResolvedValue(wanOutcome);
    const result = await generateClip(premiumRequest(reply));

    expect(wan14bClip).toHaveBeenCalledTimes(1);
    const call = wan14bClip.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      seedFrameUrl: "https://example.com/seed.png",
      personaId: "synth-persona-01",
      toneReferenceUrl: "https://example.com/tone.png",
      jobKind: "reply",
    });
    expect(call.prompt).toContain(
      `By ${LIVE_TUNABLES.WAN14B_CLIP_SEC}s she is`,
    );
    // No turbo render, no seed swap, no client clip swap.
    expect(render).not.toHaveBeenCalled();
    expect(swapTail).not.toHaveBeenCalled();
    expect(swapClip).not.toHaveBeenCalled();
    expect(extractLastFrameUrl).not.toHaveBeenCalled();

    expect(result.videoUrl).toBe(wanOutcome.videoUrl);
    expect(result.seedFrameUrl).toBe(wanOutcome.lastFrameUrl);
    expect(result.durationSec).toBe(LIVE_TUNABLES.WAN14B_CLIP_SEC);
    expect(result.loops).toBe(false);
    expect(result.swap?.status).toBe("swapped");
    expect(result.costUsd).toBe(wanOutcome.costUsd);
    expect(result.premium).toEqual({
      status: "rendered",
      wanMs: 16_000,
      reason: null,
    });
    expect(result.reply?.text).toBe("hey you");
  });

  it("starts the greeting from the uploaded reference", async () => {
    wan14bClip.mockResolvedValue(wanOutcome);
    const upload = { ...session, seedFrameUrl: session.anchorFrameUrl };
    const result = await generateClip(
      premiumRequest({ kind: "greeting" }, { session: upload }),
    );
    expect(wan14bClip).toHaveBeenCalledWith(
      expect.objectContaining({ seedFrameUrl: session.anchorFrameUrl }),
    );
    expect(result.durationSec).toBe(LIVE_TUNABLES.WAN14B_CLIP_SEC);
    expect(result.seedFrameUrl).toBe(wanOutcome.lastFrameUrl);
  });

  it("keeps idle fillers on the swap path", async () => {
    const onRendered = vi.fn();
    const result = await generateClip(
      premiumRequest({ kind: "idle" }),
      onRendered,
    );
    expect(wan14bClip).not.toHaveBeenCalled();
    expect(renderBackendFor).toHaveBeenCalledWith("swap", expect.anything());
    expect(result.swap?.status).toBe("pending");
    expect(result.premium).toBeUndefined();
    expect(onRendered).toHaveBeenCalledWith("https://example.com/turbo.mp4");
  });

  it("falls back to the swap path for this clip when the Wan service errors, and records why", async () => {
    wan14bClip.mockRejectedValue(new Error("Premium service responded 422"));
    const onRendered = vi.fn();
    const result = await generateClip(premiumRequest(reply), onRendered);

    expect(renderBackendFor).toHaveBeenCalledWith("swap", expect.anything());
    expect(render).toHaveBeenCalledTimes(1);
    expect(result.videoUrl).toBe("https://example.com/turbo.mp4");
    expect(result.durationSec).toBe(LIVE_TUNABLES.SWAP_ACTION_CLIP_SEC);
    expect(result.swap?.status).toBe("pending");
    expect(onRendered).toHaveBeenCalledWith("https://example.com/turbo.mp4");
    expect(result.seedFrameUrl).toBe("https://example.com/tail.png");
    expect(result.premium?.status).toBe("fallback");
    expect(result.premium?.reason).toContain("Premium service responded 422");
    // Her reply is written once, not again for the fallback render.
    expect(writeReply).toHaveBeenCalledTimes(1);
  });

  it("falls back on a timeout too", async () => {
    wan14bClip.mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const result = await generateClip(premiumRequest(reply));
    expect(result.premium?.status).toBe("fallback");
    expect(result.premium?.reason).toMatch(/^timeout: /);
    expect(result.swap?.status).toBe("pending");
  });
});
