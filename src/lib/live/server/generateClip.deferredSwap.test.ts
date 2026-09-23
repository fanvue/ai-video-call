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
  SWAP_GREETING_BUDGET_MS: 20_000,
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
  swapTail.mockReset();
  // No persona on these requests by default, so swapTail refuses exactly like the real client and every existing seed expectation still falls through to swapServiceLastFrame.
  swapTail.mockRejectedValue(
    new Error("No persona selected, the clip plays unswapped"),
  );
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

  it("a chain clip seeds the next clip from its raw last frame and comes back unswapped with a pending report", async () => {
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

// Seeding the chain: with a persona selected the next clip's seed comes from the swapped tail, not the raw render, so the swapped identity carries forward instead of the raw render's own drift compounding.
describe("generateClip seeds a swap-mode chain clip from /swapTail", () => {
  const personaRequest = (job: ClipRequest["job"]): ClipRequest => ({
    ...request(job),
    backend: "swap",
    personaId: "synth-persona-01",
  });
  const reply: ClipRequest["job"] = {
    kind: "reply",
    requestId: "r1",
    text: "hi",
    channel: "chat",
    from: "fan",
    precededByIdle: false,
  };

  it("seeds from the swapped tail and adds its cost, without touching the raw lastFrame path", async () => {
    swapTail.mockResolvedValue({
      lastFrameUrl: "https://example.com/tail-swapped.png",
      costUsd: 0.01,
    });
    const result = await generateClip(personaRequest(reply));
    expect(swapTail).toHaveBeenCalledWith({
      videoUrl: "https://example.com/clip.mp4",
      personaId: "synth-persona-01",
      jobKind: "reply",
    });
    expect(swapServiceLastFrame).not.toHaveBeenCalled();
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe("https://example.com/tail-swapped.png");
    expect(result.costUsd).toBeCloseTo(0.275 + 0.01, 6);
  });

  it("maps Face lock to the longlive recipe on the seed swap too", async () => {
    swapTail.mockResolvedValue({
      lastFrameUrl: "https://example.com/tail-swapped.png",
      costUsd: 0.01,
    });
    await generateClip({ ...personaRequest(reply), swapFaceLock: true });
    expect(swapTail).toHaveBeenCalledWith(
      expect.objectContaining({ recipe: "longlive" }),
    );
  });

  it("falls back to the raw last frame when the persona gate refuses the swapped tail", async () => {
    swapTail.mockRejectedValue(
      new Error("Swap service responded 422: persona gate: not in manifest"),
    );
    const result = await generateClip(personaRequest(reply));
    expect(swapServiceLastFrame).toHaveBeenCalledWith({
      videoUrl: "https://example.com/clip.mp4",
    });
    expect(result.seedFrameUrl).toBe("https://example.com/tail-raw.jpg");
  });

  it("falls back to the raw last frame with no persona selected", async () => {
    const result = await generateClip({ ...request(reply), backend: "swap" });
    expect(swapTail).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: undefined }),
    );
    expect(swapServiceLastFrame).toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe("https://example.com/tail-raw.jpg");
  });

  it("falls all the way through to fal's frame extraction when both swapTail and the raw lastFrame fail", async () => {
    swapTail.mockRejectedValue(new Error("Swap service is not configured"));
    swapServiceLastFrame.mockRejectedValue(
      new Error("Swap service responded 503"),
    );
    const result = await generateClip(personaRequest(reply));
    expect(extractLastFrameUrl).toHaveBeenCalledWith(
      "https://example.com/clip.mp4",
      expect.any(Number),
    );
    expect(result.seedFrameUrl).toBe("https://example.com/last.jpg");
  });

  it("a banked state frame still skips the tail decode entirely", async () => {
    const banked = "https://example.com/banked-sitting.png";
    const result = await generateClip({
      ...personaRequest(reply),
      session: {
        ...session,
        stateFrames: { [stateFrameKey(session.state)]: banked },
      },
    });
    expect(swapTail).not.toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe(banked);
  });
});

it("locks ROOM to what a swap-mode greeting actually rendered", async () => {
  swapServiceLastFrame.mockResolvedValue(
    "https://example.com/greeting-tail.jpg",
  );
  captureRoom.mockResolvedValueOnce(
    "A made bed, a lamp on the left, a window on the right.",
  );
  const result = await generateClip({
    ...request({ kind: "greeting" }),
    session: { ...session, seedFrameUrl: session.anchorFrameUrl },
    backend: "swap",
  });
  expect(captureRoom).toHaveBeenCalledWith(
    "https://example.com/greeting-tail.jpg",
  );
  expect(result.state.surroundings).toBe(
    "A made bed, a lamp on the left, a window on the right.",
  );
});

it("keeps the session's ROOM text for any clip after the greeting", async () => {
  captureRoom.mockClear();
  const result = await generateClip({
    ...request({
      kind: "reply",
      requestId: "r9",
      text: "hi",
      channel: "chat",
      from: "fan",
      precededByIdle: false,
    }),
    backend: "swap",
  });
  expect(captureRoom).not.toHaveBeenCalled();
  expect(result.state.surroundings).toBe(session.state.surroundings);
});

describe("intent parser", () => {
  const reply = (text: string, intentParser?: ClipRequest["intentParser"]) =>
    generateClip({
      ...request({
        kind: "reply",
        requestId: "rp",
        text,
        channel: "chat",
        from: "fan",
        precededByIdle: false,
      }),
      intentParser,
    });
  const promptOf = () =>
    (render.mock.calls.at(-1)?.[0] as { prompt: string }).prompt;

  beforeEach(() => parseIntentsWithLlm.mockReset());

  it("never calls the LLM on the default regex parser", async () => {
    await reply("brush ur hair");
    expect(parseIntentsWithLlm).not.toHaveBeenCalled();
  });

  it("hybrid skips the LLM when the catalogue already found an action", async () => {
    await reply("do a spin", "hybrid");
    expect(parseIntentsWithLlm).not.toHaveBeenCalled();
  });

  it("hybrid plans from the LLM's intents when the catalogue found none", async () => {
    parseIntentsWithLlm.mockResolvedValueOnce([
      { type: "act", act: "gesture" },
    ]);
    await reply("giv us a lil hello with ur hand", "hybrid");
    expect(parseIntentsWithLlm).toHaveBeenCalledTimes(1);
    expect(promptOf()).toMatch(/warm wave/i);
  });

  it("falls back to the catalogue when the LLM returns nothing", async () => {
    parseIntentsWithLlm.mockResolvedValueOnce(null);
    await reply("do a spin", "llm");
    expect(promptOf()).toMatch(/360-degree/);
  });
});

it("keeps swap-mode chain clips off reference-to-video by default", () => {
  expect(LIVE_TUNABLES.SWAP_CHAIN_FROM_REFERENCE).toBe(false);
});

describe("generateClip on the swap backend with chain clips from reference-to-video", () => {
  const identityFrameUrl = "https://example.com/identity-crop.jpg";
  const swapRequest = (job: ClipRequest["job"]): ClipRequest => ({
    ...request(job),
    backend: "swap",
    session: { ...session, identityFrameUrl },
  });
  const reply: ClipRequest["job"] = {
    kind: "reply",
    requestId: "r1",
    text: "hi",
    channel: "chat",
    from: "fan",
    precededByIdle: false,
  };

  // Off by default (see LIVE_TUNABLES); these cover the path when it is switched on.
  beforeEach(() => {
    const tunables = LIVE_TUNABLES as { SWAP_CHAIN_FROM_REFERENCE: boolean };
    tunables.SWAP_CHAIN_FROM_REFERENCE = true;
    onTestFinished(() => {
      tunables.SWAP_CHAIN_FROM_REFERENCE = false;
    });
  });

  it("stays on turbo when there is no head-only crop, never handing reference-to-video the full upload", async () => {
    await generateClip({ ...request(reply), backend: "swap" });
    expect(renderBackendFor).toHaveBeenLastCalledWith(
      "swap",
      expect.objectContaining({ chainFromReference: false }),
    );
  });

  it("routes a reply to the reference backend with the head-only crop as its identity image, not the full upload", async () => {
    renderBackendFor.mockReturnValueOnce({
      render,
      supportsEndFrame: false,
      supportsIdentityReference: true,
    } as never);
    await generateClip(
      swapRequest({
        kind: "reply",
        requestId: "r1",
        text: "hi",
        channel: "chat",
        from: "fan",
        precededByIdle: false,
      }),
    );
    expect(renderBackendFor).toHaveBeenLastCalledWith(
      "swap",
      expect.objectContaining({ chainFromReference: true }),
    );
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        identityReferenceUrl: identityFrameUrl,
        endFrameUrl: undefined,
      }),
    );
  });

  it("keeps idles and the greeting off it, so idles can still loop on turbo's end frame", async () => {
    await generateClip(swapRequest({ kind: "idle" }));
    expect(renderBackendFor).toHaveBeenLastCalledWith(
      "swap",
      expect.objectContaining({ chainFromReference: false }),
    );
    await generateClip(swapRequest({ kind: "greeting" }));
    expect(renderBackendFor).toHaveBeenLastCalledWith(
      "swap",
      expect.objectContaining({ chainFromReference: false }),
    );
  });

  it("never applies to other backends", async () => {
    await generateClip(swapRequest({ kind: "checkIn", channel: "chat" }));
    await generateClip(request({ kind: "checkIn", channel: "chat" }));
    expect(renderBackendFor).toHaveBeenLastCalledWith(
      "turbo",
      expect.objectContaining({ chainFromReference: false }),
    );
  });
});
