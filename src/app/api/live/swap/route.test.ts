import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/live/server/swapClip", () => ({
  SWAP_BUDGET_MS: 150_000,
  SWAP_GREETING_BUDGET_MS: 20_000,
  swapClip: vi.fn(),
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

const { getCurrentUser } = await import("@/lib/fanvue");
const { swapClip } = await import("@/lib/live/server/swapClip");
const { POST } = await import("./route");

const body = {
  videoUrl: "https://v3.fal.media/files/clip.mp4",
  personaId: "synth-persona-01",
  jobKind: "reply",
};
const jsonBody = (value: unknown) =>
  new Request("https://example.com/api/live/swap", {
    method: "POST",
    body: JSON.stringify(value),
  });

beforeEach(() => {
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(swapClip).mockReset();
});

describe("POST /api/live/swap", () => {
  it("rejects an unauthenticated caller", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    const response = await POST(jsonBody(body));
    expect(response.status).toBe(401);
    expect(swapClip).not.toHaveBeenCalled();
  });

  it("only forwards fal-hosted URLs to the swap service", async () => {
    const response = await POST(
      jsonBody({ ...body, videoUrl: "https://evil.example.com/clip.mp4" }),
    );
    expect(response.status).toBe(400);
    expect(swapClip).not.toHaveBeenCalled();
  });

  it("finishes the clip swap with the mid-session budget and returns the swapped clip", async () => {
    vi.mocked(swapClip).mockResolvedValue({
      videoUrl: "https://v3.fal.media/files/swapped.mp4",
      lastFrameUrl: "https://v3.fal.media/files/last.jpg",
      costUsd: 0.004,
      report: {
        status: "swapped",
        swapMs: 6000,
        frames: 360,
        framesWithFace: 360,
        msPerFrame: 16,
        similarityBefore: 0.6,
        similarityAfter: 0.9,
        restored: true,
        reason: null,
      },
    });
    const response = await POST(jsonBody(body));
    const data = (await response.json()) as {
      videoUrl: string;
      lastFrameUrl: string;
      costUsd: number;
      report: { status: string };
    };
    expect(swapClip).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetMs: 150_000,
        jobKind: "reply",
        personaId: "synth-persona-01",
      }),
    );
    expect(data.videoUrl).toBe("https://v3.fal.media/files/swapped.mp4");
    expect(data.lastFrameUrl).toBe("https://v3.fal.media/files/last.jpg");
    expect(data.report.status).toBe("swapped");
  });

  it("never passes an uploaded reference to the swap, even when the client sends one", async () => {
    vi.mocked(swapClip).mockRejectedValue(new Error("stop"));
    await POST(
      jsonBody({
        ...body,
        referenceImageUrl: "https://v3b.fal.media/files/anchor.jpg",
      }),
    );
    const [args] = vi.mocked(swapClip).mock.calls[0];
    expect(Object.keys(args).sort()).toEqual(
      ["budgetMs", "jobKind", "personaId", "swapModel", "videoUrl"].sort(),
    );
    expect(JSON.stringify(args)).not.toContain("anchor.jpg");
  });

  it("rejects a malformed persona id before any swap", async () => {
    for (const personaId of ["../manifest", "Synth", "a".repeat(65), 7]) {
      const response = await POST(jsonBody({ ...body, personaId }));
      expect(response.status).toBe(400);
    }
    expect(swapClip).not.toHaveBeenCalled();
  });

  it("plays unswapped with the reason when no persona is selected", async () => {
    vi.mocked(swapClip).mockRejectedValue(
      new Error("No persona selected, the clip plays unswapped"),
    );
    const response = await POST(jsonBody({ ...body, personaId: undefined }));
    const data = (await response.json()) as {
      videoUrl: string;
      report: { status: string; reason: string };
    };
    expect(swapClip).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: undefined }),
    );
    expect(data.videoUrl).toBe(body.videoUrl);
    expect(data.report).toMatchObject({ status: "failed" });
    expect(data.report.reason).toMatch(/No persona selected/);
  });

  it("maps the session's swap profile to its model and rejects unknown profiles", async () => {
    vi.mocked(swapClip).mockRejectedValue(new Error("stop"));
    await POST(jsonBody({ ...body, swapProfile: "ghost_1" }));
    expect(swapClip).toHaveBeenCalledWith(
      expect.objectContaining({ swapModel: "ghost_1" }),
    );
    const rejected = await POST(jsonBody({ ...body, swapProfile: "simswap" }));
    expect(rejected.status).toBe(400);
  });

  it("gives the greeting the short budget and fails open to the unswapped clip", async () => {
    vi.mocked(swapClip).mockRejectedValue(
      new Error("Swap service responded 503"),
    );
    const response = await POST(jsonBody({ ...body, jobKind: "greeting" }));
    const data = (await response.json()) as {
      videoUrl: string;
      report: { status: string; reason: string };
    };
    expect(swapClip).toHaveBeenCalledWith(
      expect.objectContaining({ budgetMs: 20_000, jobKind: "greeting" }),
    );
    expect(response.status).toBe(200);
    expect(data.videoUrl).toBe(body.videoUrl);
    expect(data.report.status).toBe("failed");
    expect(data.report.reason).toMatch(/503/);
  });
});
