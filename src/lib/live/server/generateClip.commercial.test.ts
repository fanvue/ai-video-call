import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
const swapTail = vi.fn();
// Fully mocked: the real module pulls in @/env, which validates the server environment at import.
vi.mock("./swapClip", () => ({
  SWAP_BUDGET_MS: 150_000,
  swapGreetingBudgetMsFor: (recipe?: string) =>
    recipe === "longlive" ? 40_000 : 20_000,
  swapFailureReason: () => "error",
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

// The real module pulls in @/env; Premium routing has its own tests in generateClip.premium.test.ts.
vi.mock("./wan14bClip", () => ({ wan14bClip: vi.fn() }));

const captureRoom = vi.fn(async (): Promise<string | null> => null);
vi.mock("./captureRoom", () => ({
  captureRoom: (...args: unknown[]) =>
    (captureRoom as (...a: unknown[]) => Promise<string | null>)(...args),
}));

const parseIntentsWithLlm = vi.fn(async (): Promise<unknown> => null);
vi.mock("./parseIntents", () => ({
  parseIntentsWithLlm: (...args: unknown[]) =>
    (parseIntentsWithLlm as (...a: unknown[]) => Promise<unknown>)(...args),
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

const commercialRequest = (job: ClipRequest["job"]): ClipRequest => ({
  session,
  job,
  backend: "commercial",
  speechMode: "text",
  useIdentityReference: false,
});

const REPLY: ClipRequest["job"] = {
  kind: "reply",
  requestId: "r1",
  text: "hi",
  channel: "chat",
  from: "fan",
  precededByIdle: false,
};

beforeEach(() => {
  render.mockReset();
  renderBackendFor.mockClear();
  swapClip.mockReset();
  swapServiceLastFrame.mockReset();
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

const expectNoSwapService = () => {
  expect(swapClip).not.toHaveBeenCalled();
  expect(swapTail).not.toHaveBeenCalled();
  expect(swapServiceLastFrame).not.toHaveBeenCalled();
};

// Commercial is swap mode minus the face swap: same h3 renders and seeds, but nothing reaches the swap service.
describe("generateClip on the commercial backend", () => {
  it("a chain clip comes back playable, unswapped, seeded from its raw last frame, without logging a swap failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const onRendered = vi.fn();
    const result = await generateClip(commercialRequest(REPLY), onRendered);
    expectNoSwapService();
    expect(extractLastFrameUrl).toHaveBeenCalledWith(
      "https://example.com/clip.mp4",
      expect.any(Number),
    );
    expect(result.videoUrl).toBe("https://example.com/clip.mp4");
    expect(result.seedFrameUrl).toBe("https://example.com/last.jpg");
    expect(result.swap).toBeUndefined();
    expect(result.verdict).toBe("approved");
    expect(result.costUsd).toBe(0.275);
    expect(onRendered).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("swap")),
    ).toBe(false);
  });

  it("renders the greeting on the raw upload through reference-to-video, like swap", async () => {
    const result = await generateClip({
      ...commercialRequest({ kind: "greeting" }),
      session: { ...session, seedFrameUrl: session.anchorFrameUrl },
    });
    expectNoSwapService();
    expect(renderBackendFor).toHaveBeenCalledWith("commercial", {
      greetingFromReference: true,
      chainFromReference: false,
    });
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Image 1 is the woman's identity only"),
        durationSec: LIVE_TUNABLES.SWAP_GREETING_CLIP_SEC,
      }),
    );
    expect(result.swap).toBeUndefined();
  });

  it("an idle filler loops on its seed with no swap pending", async () => {
    const result = await generateClip(commercialRequest({ kind: "idle" }));
    expectNoSwapService();
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe(session.seedFrameUrl);
    expect(result.swap).toBeUndefined();
  });

  it("uses swap's pose bank for a chain clip landing in a banked state", async () => {
    const banked = "https://example.com/banked-sitting.png";
    const result = await generateClip({
      ...commercialRequest({ kind: "checkIn", channel: "chat" }),
      session: {
        ...session,
        stateFrames: { [stateFrameKey(session.state)]: banked },
      },
    });
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: banked }),
    );
    expectNoSwapService();
    expect(result.seedFrameUrl).toBe(banked);
  });

  it("ignores a persona id instead of reaching the swap service's persona gate", async () => {
    await generateClip({
      ...commercialRequest(REPLY),
      personaId: "aria",
      swapFaceLock: true,
    });
    expectNoSwapService();
  });
});
