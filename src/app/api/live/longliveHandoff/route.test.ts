import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";
import type { ClipResult, ClipSwapReport } from "@/lib/live/contract";

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/fal/uploadImage", () => ({ uploadToFal: vi.fn() }));
vi.mock("@/lib/groq", () => ({
  GROQ_TEXT_MODEL: "test-model",
  createGroqChatCompletion: () => Promise.reject(new Error("groq down")),
}));
vi.mock("@/lib/live/server/generateClip", () => ({ generateClip: vi.fn() }));
vi.mock("@/lib/live/server/swapClip", () => ({
  SWAP_BUDGET_MS: 150_000,
  swapClip: vi.fn(),
}));

const { getCurrentUser } = await import("@/lib/fanvue");
const { uploadToFal } = await import("@/lib/fal/uploadImage");
const { generateClip } = await import("@/lib/live/server/generateClip");
const { swapClip } = await import("@/lib/live/server/swapClip");
const { POST } = await import("./route");

const state = defaultLiveState("bedroom", {
  top: { on: false, description: "top" },
  bottom: { on: false, description: "bottoms" },
  bra: { on: true, description: "white bra" },
  panties: { on: true, description: "white panties" },
  removedOrder: [],
});
const braOff = {
  ...state,
  wardrobe: {
    ...state.wardrobe,
    bra: { on: false, description: "white bra" },
    removedOrder: ["bra" as const],
  },
};

const body = {
  creator: defaultCreatorProfile("Mia", "bedroom", "Auburn hair."),
  state,
  transcript: [],
  requestId: "longlive-fan-3",
  text: "take your bra off",
  channel: "chat",
  elapsedSec: 42,
  frameBase64: "AAAA",
  anchorFrameUrl: "https://v3.fal.media/files/anchor.jpg",
};

const swapReport = (status: ClipSwapReport["status"]): ClipSwapReport => ({
  status,
  swapMs: 0,
  frames: 0,
  framesWithFace: 0,
  msPerFrame: 0,
  similarityBefore: null,
  similarityAfter: null,
  restored: false,
  reason: null,
});

const clip = (overrides: Partial<ClipResult> = {}): ClipResult => ({
  clipId: "c1",
  jobKind: "reply",
  videoUrl: "https://v3.fal.media/files/raw.mp4",
  durationSec: 11,
  seedFrameUrl: "https://v3.fal.media/files/raw-last.jpg",
  loops: false,
  state: braOff,
  reply: null,
  followUps: [],
  guard: { checked: false, issues: [], repaired: false },
  observed: null,
  verdict: "approved",
  rejectReason: null,
  timings: { planMs: 0, renderMs: 0, frameMs: 0, guardMs: 0, repairMs: 0 },
  costUsd: 0.3,
  swap: swapReport("pending"),
  ...overrides,
});

const post = (payload: unknown) =>
  POST(
    new Request("http://localhost/api/live/longliveHandoff", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );

beforeEach(() => {
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(uploadToFal)
    .mockReset()
    .mockResolvedValue("https://v3b.fal.media/files/seed.jpg");
  vi.mocked(generateClip).mockReset().mockResolvedValue(clip());
  vi.mocked(swapClip)
    .mockReset()
    .mockResolvedValue({
      videoUrl: "https://v3.fal.media/files/swapped.mp4",
      lastFrameUrl: "https://v3.fal.media/files/swapped-last.jpg",
      report: swapReport("swapped"),
      costUsd: 0.01,
    });
});

describe("POST /api/live/longliveHandoff", () => {
  it("rejects unauthenticated requests before any upload or render", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    expect((await post(body)).status).toBe(401);
    expect(uploadToFal).not.toHaveBeenCalled();
    expect(generateClip).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing frame", { ...body, frameBase64: "" }],
    ["an oversized frame", { ...body, frameBase64: "A".repeat(1_500_001) }],
    [
      "a non-fal anchor",
      { ...body, anchorFrameUrl: "https://example.com/a.jpg" },
    ],
    ["no request text", { ...body, text: "" }],
    ["a minor cue", { ...body, text: "take your bra off schoolgirl" }],
  ])("rejects %s with 400", async (_, payload) => {
    expect((await post(payload)).status).toBe(400);
    expect(generateClip).not.toHaveBeenCalled();
  });

  it("renders a swap reply clip from the uploaded stream frame, finishes the swap, and returns the restart scene", async () => {
    const response = await post(body);
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      videoUrl: "https://v3.fal.media/files/swapped.mp4",
      lastFrameUrl: "https://v3.fal.media/files/swapped-last.jpg",
      state: braOff,
    });
    expect(json.settlePrompt).toEqual(expect.stringContaining("topless"));
    expect(vi.mocked(uploadToFal).mock.calls[0]?.[2]).toBe("image/jpeg");
    const request = vi.mocked(generateClip).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      backend: "swap",
      job: { kind: "reply", requestId: "longlive-fan-3", text: body.text },
      session: {
        seedFrameUrl: "https://v3b.fal.media/files/seed.jpg",
        anchorFrameUrl: body.anchorFrameUrl,
        elapsedSec: 42,
      },
    });
    expect(vi.mocked(swapClip).mock.calls[0]?.[0]).toMatchObject({
      videoUrl: "https://v3.fal.media/files/raw.mp4",
      referenceImageUrl: body.anchorFrameUrl,
      jobKind: "reply",
    });
  });

  it("uses the clip's own swapped tail when the swap already ran inline", async () => {
    vi.mocked(generateClip).mockResolvedValue(
      clip({ swap: swapReport("swapped") }),
    );
    const json = (await (await post(body)).json()) as Record<string, unknown>;
    expect(json.lastFrameUrl).toBe("https://v3.fal.media/files/raw-last.jpg");
    expect(swapClip).not.toHaveBeenCalled();
  });

  it.each([
    ["the render throws", () => generateClip, new Error("fal down")],
    ["the swap throws", () => swapClip, new Error("swap down")],
  ])("fails closed with 502 when %s", async (_, target, error) => {
    vi.mocked(target()).mockRejectedValue(error);
    expect((await post(body)).status).toBe(502);
  });

  it("fails closed when the clip was rejected or its swap failed", async () => {
    vi.mocked(generateClip).mockResolvedValueOnce(
      clip({ verdict: "rejected", rejectReason: "no seed" }),
    );
    expect((await post(body)).status).toBe(502);
    vi.mocked(generateClip).mockResolvedValueOnce(
      clip({ swap: swapReport("failed") }),
    );
    expect((await post(body)).status).toBe(502);
  });

  it("fails closed when the last frame is on a host the stream would refuse", async () => {
    vi.mocked(swapClip).mockResolvedValue({
      videoUrl: "https://v3.fal.media/files/swapped.mp4",
      lastFrameUrl: "https://example.com/last.jpg",
      report: swapReport("swapped"),
      costUsd: 0,
    });
    expect((await post(body)).status).toBe(502);
  });
});
