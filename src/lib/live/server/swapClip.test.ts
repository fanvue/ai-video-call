import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  SWAP_SERVICE_URL: "https://swap.test" as string | undefined,
  SWAP_TOKEN: "0123456789abcdef0123456789abcdef" as string | undefined,
}));
vi.mock("@/env", () => ({ env: envMock }));

const uploadToFal = vi.fn();
vi.mock("@/lib/fal/uploadImage", () => ({
  uploadToFal: (...args: unknown[]) => uploadToFal(...args),
}));

const {
  failedSwapReport,
  swapClip,
  swapGreetingBudgetMsFor,
  swapServiceLastFrame,
  swapTail,
} = await import("./swapClip");

const serviceStats = {
  frames: 240,
  frames_with_face: 238,
  fps: 24,
  swap_ms: 12_000,
  ms_per_frame: 50,
  similarity_before: 0.31,
  similarity_after: 0.72,
  restored: true,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("swapClip", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    uploadToFal.mockReset();
    envMock.SWAP_SERVICE_URL = "https://swap.test";
    envMock.SWAP_TOKEN = "0123456789abcdef0123456789abcdef";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const swapped = () =>
    jsonResponse({
      video_base64: Buffer.from("video").toString("base64"),
      last_frame_base64: Buffer.from("frame").toString("base64"),
      stats: serviceStats,
    });

  it("posts the clip and the persona id to the service with the bearer token, rehosts both outputs on fal and prices the reported swap time", async () => {
    fetchMock.mockResolvedValueOnce(swapped());
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");

    const outcome = await swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://swap.test/swapClip");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer 0123456789abcdef0123456789abcdef",
    );
    // The upload never reaches the swap: the body names the persona and nothing else identifies a face.
    expect(JSON.parse(init.body as string)).toEqual({
      video_url: "https://fal.test/turbo.mp4",
      persona_id: "synth-persona-01",
    });
    expect(uploadToFal.mock.calls[0][2]).toBe("video/mp4");
    expect(uploadToFal.mock.calls[1][1]).toMatch(/-last\.png$/);
    expect(uploadToFal.mock.calls[1][2]).toBe("image/png");
    expect(outcome.videoUrl).toBe("https://fal.test/swap.mp4");
    expect(outcome.lastFrameUrl).toBe("https://fal.test/last.jpg");
    expect(outcome.report).toMatchObject({
      status: "swapped",
      frames: 240,
      framesWithFace: 238,
      msPerFrame: 50,
      similarityBefore: 0.31,
      similarityAfter: 0.72,
      restored: true,
    });
    expect(outcome.costUsd).toBeCloseTo((12 * 1.95) / 3600, 6);
  });

  it("sends a test profile's swap model to the service", async () => {
    fetchMock.mockResolvedValueOnce(swapped());
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");

    await swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      swapModel: "hyperswap_1c",
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "hyperswap_1c",
    });
  });

  it("sends the Face lock recipe to the service", async () => {
    fetchMock.mockResolvedValueOnce(swapped());
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");

    await swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      recipe: "longlive",
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      recipe: "longlive",
    });
  });

  it("sends a split reply's frame range and reports the swapped fps, so the client knows how long the head is", async () => {
    fetchMock.mockResolvedValueOnce(swapped());
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");

    const outcome = await swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      startFrame: 100,
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.start_frame).toBe(100);
    expect(sent).not.toHaveProperty("end_frame");
    expect(outcome.report.fps).toBe(serviceStats.fps);
  });

  it("omits the recipe when Face lock is off, so the service's own legacy default governs", async () => {
    fetchMock.mockResolvedValueOnce(swapped());
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");

    await swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("recipe");
  });

  it("sends the Hand mask to the service, and omits it when off so the service default governs", async () => {
    fetchMock.mockResolvedValueOnce(swapped()).mockResolvedValueOnce(swapped());
    uploadToFal.mockResolvedValue("https://fal.test/out");

    await swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      handMask: true,
    });
    await swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      handMask: false,
    });

    const bodies = (fetchMock.mock.calls as [URL, RequestInit][]).map(
      ([, init]) => JSON.parse(init.body as string) as Record<string, unknown>,
    );
    expect(bodies[0]).toMatchObject({ occlusion_mask: true });
    expect(bodies[1]).not.toHaveProperty("occlusion_mask");
  });

  it("refuses without a persona and never contacts the service or fetches a reference", async () => {
    for (const personaId of [undefined, ""]) {
      await expect(
        swapClip({ videoUrl: "https://fal.test/turbo.mp4", personaId }),
      ).rejects.toThrow("No persona selected");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadToFal).not.toHaveBeenCalled();
  });

  it("throws before contacting the service when it is not configured", async () => {
    envMock.SWAP_TOKEN = undefined;
    await expect(
      swapClip({
        videoUrl: "https://fal.test/turbo.mp4",
        personaId: "synth-persona-01",
      }),
    ).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the persona gate's refusal with its status and reason, without retrying", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { detail: "persona gate: synth-persona-99: not in manifest" },
        422,
      ),
    );
    await expect(
      swapClip({
        videoUrl: "https://fal.test/turbo.mp4",
        personaId: "synth-persona-99",
      }),
    ).rejects.toThrow(/422.*not in manifest/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uploadToFal).not.toHaveBeenCalled();
  });

  it("retries once when the service drops the input with a 408", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("Missing request", { status: 408 }))
      .mockResolvedValueOnce(swapped());
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");

    const outcome = await swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.report.status).toBe("swapped");
    expect(fetchMock.mock.calls[1][1].body).toBe(
      fetchMock.mock.calls[0][1].body,
    );
  });

  it("races a second request when the first hangs, and cancels the hung one", async () => {
    vi.useFakeTimers();
    let hungSignal: AbortSignal | undefined;
    fetchMock
      .mockImplementationOnce((_url: URL, init: RequestInit) => {
        hungSignal = init.signal ?? undefined;
        return new Promise(() => undefined);
      })
      .mockResolvedValueOnce(swapped());
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");

    const pending = swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
    });
    await vi.advanceTimersByTimeAsync(8_000);
    const outcome = await pending;
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.videoUrl).toBe("https://fal.test/swap.mp4");
    expect(hungSignal?.aborted).toBe(true);
  });

  it("does not hedge the longlive recipe at the legacy 8s delay, only once its own 30s passes", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      recipe: "longlive",
    });
    // Legacy's hedge point: a longlive swap at 45.5ms/frame is still healthy here, so no second request yet.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(swapped());
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");
    await vi.advanceTimersByTimeAsync(22_000);
    const outcome = await pending;
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.videoUrl).toBe("https://fal.test/swap.mp4");
  });

  it("does not hedge a hand-masked legacy swap at the plain 8s delay, only once its own 13s passes", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      handMask: true,
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(swapped());
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await pending;
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.videoUrl).toBe("https://fal.test/swap.mp4");
  });

  it("gives up after a second 408", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("Missing request", { status: 408 }))
      .mockResolvedValueOnce(new Response("Missing request", { status: 408 }));
    await expect(
      swapClip({
        videoUrl: "https://fal.test/turbo.mp4",
        personaId: "synth-persona-01",
      }),
    ).rejects.toThrow(/408/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("swapServiceLastFrame", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    uploadToFal.mockReset();
    envMock.SWAP_SERVICE_URL = "https://swap.test";
    envMock.SWAP_TOKEN = "0123456789abcdef0123456789abcdef";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the service for the finished seed with the bearer token and rehosts it lossless", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        last_frame_base64: Buffer.from("seed").toString("base64"),
        stats: { download_ms: 400, total_ms: 900 },
      }),
    );
    uploadToFal.mockResolvedValueOnce("https://fal.test/seed.png");

    const url = await swapServiceLastFrame({
      videoUrl: "https://fal.test/turbo.mp4",
      toneReferenceUrl: "https://fal.test/first-seed.png",
    });

    const [target, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe("https://swap.test/lastFrame");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer 0123456789abcdef0123456789abcdef",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      video_url: "https://fal.test/turbo.mp4",
      tone_reference_url: "https://fal.test/first-seed.png",
    });
    expect(uploadToFal.mock.calls[0][1]).toMatch(/^seed-.*\.png$/);
    expect(uploadToFal.mock.calls[0][2]).toBe("image/png");
    expect(url).toBe("https://fal.test/seed.png");
  });
});

describe("swapTail", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    uploadToFal.mockReset();
    envMock.SWAP_SERVICE_URL = "https://swap.test";
    envMock.SWAP_TOKEN = "0123456789abcdef0123456789abcdef";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tailResponse = () =>
    jsonResponse({
      last_frame_base64: Buffer.from("tail").toString("base64"),
      stats: {
        swap_ms: 400,
        had_face: true,
        similarity_before: 0.4,
        similarity_after: 0.8,
      },
    });

  it("posts the clip and persona id to the service and rehosts the swapped seed", async () => {
    fetchMock.mockResolvedValueOnce(tailResponse());
    uploadToFal.mockResolvedValueOnce("https://fal.test/tail.png");

    const outcome = await swapTail({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://swap.test/swapTail");
    expect(JSON.parse(init.body as string)).toEqual({
      video_url: "https://fal.test/turbo.mp4",
      persona_id: "synth-persona-01",
    });
    expect(outcome.lastFrameUrl).toBe("https://fal.test/tail.png");
    expect(outcome.costUsd).toBeCloseTo((0.4 * 1.95) / 3600, 6);
  });

  it("sends the Face lock recipe to the service", async () => {
    fetchMock.mockResolvedValueOnce(tailResponse());
    uploadToFal.mockResolvedValueOnce("https://fal.test/tail.png");

    await swapTail({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      recipe: "longlive",
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      recipe: "longlive",
    });
  });

  it("sends the Hand mask on the seed swap too", async () => {
    fetchMock.mockResolvedValueOnce(tailResponse());
    uploadToFal.mockResolvedValueOnce("https://fal.test/tail.png");

    await swapTail({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      handMask: true,
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      occlusion_mask: true,
    });
  });

  it("sends the session's tone reference so the service can lock the seed's face tone", async () => {
    fetchMock.mockResolvedValueOnce(tailResponse());
    uploadToFal.mockResolvedValueOnce("https://fal.test/tail.png");

    await swapTail({
      videoUrl: "https://fal.test/turbo.mp4",
      personaId: "synth-persona-01",
      toneReferenceUrl: "https://fal.test/first-seed.png",
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      tone_reference_url: "https://fal.test/first-seed.png",
    });
  });

  it("refuses without a persona and never contacts the service", async () => {
    await expect(
      swapTail({
        videoUrl: "https://fal.test/turbo.mp4",
        personaId: undefined,
      }),
    ).rejects.toThrow("No persona selected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("swapGreetingBudgetMsFor", () => {
  it("gives a hand-masked greeting more room than the plain recipe, and longlive at least its own", () => {
    expect(swapGreetingBudgetMsFor(undefined)).toBe(20_000);
    expect(swapGreetingBudgetMsFor(undefined, true)).toBe(33_000);
    expect(swapGreetingBudgetMsFor("longlive")).toBe(40_000);
    expect(swapGreetingBudgetMsFor("longlive", true)).toBeGreaterThanOrEqual(
      swapGreetingBudgetMsFor("longlive"),
    );
  });
});

describe("failedSwapReport", () => {
  it("keeps the elapsed time and a bounded reason", () => {
    const report = failedSwapReport(1234, new Error("x".repeat(400)));
    expect(report.status).toBe("failed");
    expect(report.swapMs).toBe(1234);
    expect(report.reason).toHaveLength(300);
  });
});
