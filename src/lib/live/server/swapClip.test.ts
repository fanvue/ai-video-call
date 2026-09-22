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

const { failedSwapReport, swapClip, swapServiceLastFrame } = await import(
  "./swapClip"
);

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

  it("posts the clip and reference to the service with the bearer token, rehosts both outputs on fal and prices the reported swap time", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          video_base64: Buffer.from("video").toString("base64"),
          last_frame_base64: Buffer.from("frame").toString("base64"),
          stats: serviceStats,
        }),
      );
    uploadToFal
      .mockResolvedValueOnce("https://fal.test/swap.mp4")
      .mockResolvedValueOnce("https://fal.test/last.jpg");

    const outcome = await swapClip({
      videoUrl: "https://fal.test/turbo.mp4",
      referenceImageUrl: "https://fal.test/reference.png",
    });

    const [url, init] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(url.toString()).toBe("https://swap.test/swapClip");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer 0123456789abcdef0123456789abcdef",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      video_url: "https://fal.test/turbo.mp4",
      reference_image: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
    });
    expect(uploadToFal.mock.calls[0][2]).toBe("video/mp4");
    expect(uploadToFal.mock.calls[1][2]).toBe("image/jpeg");
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

  it("throws before contacting the service when it is not configured", async () => {
    envMock.SWAP_TOKEN = undefined;
    await expect(
      swapClip({
        videoUrl: "https://fal.test/turbo.mp4",
        referenceImageUrl: "https://fal.test/reference.png",
      }),
    ).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a service rejection with its status and detail", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1])))
      .mockResolvedValueOnce(
        jsonResponse(
          { detail: "reference must contain exactly one face" },
          422,
        ),
      );
    // A reference URL the earlier test has not cached, so the first mocked fetch is the reference.
    await expect(
      swapClip({
        videoUrl: "https://fal.test/turbo.mp4",
        referenceImageUrl: "https://fal.test/reference-two-faces.png",
      }),
    ).rejects.toThrow(/422.*exactly one face/);
    expect(uploadToFal).not.toHaveBeenCalled();
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
    });

    const [target, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe("https://swap.test/lastFrame");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer 0123456789abcdef0123456789abcdef",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      video_url: "https://fal.test/turbo.mp4",
    });
    expect(uploadToFal.mock.calls[0][1]).toMatch(/^seed-.*\.png$/);
    expect(uploadToFal.mock.calls[0][2]).toBe("image/png");
    expect(url).toBe("https://fal.test/seed.png");
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
