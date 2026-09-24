import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ClipRequest, type LiveSessionSnapshot } from "../contract";

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

const writeReply = vi.fn(async () => ({
  text: "hey you",
  nextWorld: "chatting",
}));
vi.mock("./writeReply", () => ({
  writeReply: (...args: unknown[]) =>
    (writeReply as (...a: unknown[]) => Promise<unknown>)(...args),
  writeCheckIn: vi.fn(async () => null),
}));

const directClip = vi.fn();
const hardLimitHold = vi.fn((): unknown => null);
// Mocked so these tests pin the routing; the Director itself is covered in directClip.test.ts.
vi.mock("./directClip", () => ({
  directClip: (...args: unknown[]) => directClip(...args),
  hardLimitHold: (...args: unknown[]) =>
    (hardLimitHold as (...a: unknown[]) => unknown)(...args),
}));

const { generateClip } = await import("./generateClip");
const { planClip } = await import("./planClip");

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

const REPLY: ClipRequest["job"] = {
  kind: "reply",
  requestId: "r1",
  text: "fetch ur dildo and suck it on all fours",
  channel: "chat",
  from: "fan",
  precededByIdle: false,
};

const requestFor = (
  planner: ClipRequest["planner"],
  backend: ClipRequest["backend"] = "commercial",
): ClipRequest => ({
  session,
  job: REPLY,
  backend,
  speechMode: "text",
  useIdentityReference: false,
  ...(planner ? { planner } : {}),
});

const directorPlan = () => ({
  ...planClip({
    session,
    job: REPLY,
    speechMode: "text",
    backend: "commercial",
  }),
  prompt: "0-2s: DIRECTED BEATS",
  replyPhysical: "fetch the dildo; suck it. 0-2s: DIRECTED BEATS",
});

beforeEach(() => {
  render.mockReset();
  directClip.mockReset();
  hardLimitHold.mockReset();
  hardLimitHold.mockReturnValue(null);
  writeReply.mockClear();
  parseIntentsWithLlm.mockClear();
  extractLastFrameUrl.mockReset();
  render.mockResolvedValue({
    videoUrl: "https://example.com/clip.mp4",
    costUsd: 0.275,
  });
  extractLastFrameUrl.mockResolvedValue("https://example.com/last.jpg");
});

const physicalSent = () =>
  (
    writeReply.mock.calls[0] as unknown as [{ physical: string }] | undefined
  )?.[0].physical;

describe("generateClip planner routing", () => {
  it("an explicit catalogue session never calls the Director", async () => {
    await generateClip(requestFor("catalogue"));
    expect(directClip).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledOnce();
  });

  it("a default session is directed", async () => {
    directClip.mockResolvedValue(directorPlan());
    await generateClip(requestFor(undefined));
    expect(directClip).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "0-2s: DIRECTED BEATS" }),
    );
  });

  it("renders the Director's plan and hands writeReply what she does", async () => {
    directClip.mockResolvedValue(directorPlan());
    await generateClip(requestFor("director"));
    expect(directClip).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "0-2s: DIRECTED BEATS" }),
    );
    expect(physicalSent()).toBe(
      "fetch the dildo; suck it. 0-2s: DIRECTED BEATS",
    );
  });

  it("falls back to the catalogue plan when the Director returns nothing", async () => {
    directClip.mockResolvedValue(null);
    await generateClip(requestFor("director"));
    const prompt = (render.mock.calls[0] as unknown as [{ prompt: string }])[0]
      .prompt;
    expect(prompt).not.toContain("DIRECTED BEATS");
    expect(physicalSent()).toBe(prompt);
  });

  it("only directs reply clips", async () => {
    await generateClip({ ...requestFor("director"), job: { kind: "idle" } });
    expect(directClip).not.toHaveBeenCalled();
  });

  it("holds a hard-limit request on the catalogue planner before any LLM reads it", async () => {
    hardLimitHold.mockReturnValue({ ...directorPlan(), prompt: "HELD" });
    await generateClip(requestFor("catalogue"));
    expect(parseIntentsWithLlm).not.toHaveBeenCalled();
    expect(directClip).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "HELD" }),
    );
  });
});
