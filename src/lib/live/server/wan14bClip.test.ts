import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_TUNABLES } from "../contract";

const envMock = vi.hoisted(() => ({
  WAN14B_SERVICE_URL: "https://wan14b.test" as string | undefined,
  SWAP_TOKEN: "0123456789abcdef0123456789abcdef" as string | undefined,
}));
vi.mock("@/env", () => ({ env: envMock }));

const uploadToFal = vi.fn();
vi.mock("@/lib/fal/uploadImage", () => ({
  uploadToFal: (...args: unknown[]) => uploadToFal(...args),
}));

const { wan14bClip, WAN14B_BUDGET_MS } = await import("./wan14bClip");

const stats = {
  render_ms: 12_400,
  decode_ms: 2_700,
  swap_ms: 1_200,
  encode_ms: 900,
  total_ms: 18_000,
  num_frames: 81,
  fps: 16,
  frames_with_face: 80,
  tone_locked: true,
  similarity_after: 0.82,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("wan14bClip", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    envMock.WAN14B_SERVICE_URL = "https://wan14b.test";
    envMock.SWAP_TOKEN = "0123456789abcdef0123456789abcdef";
    fetchMock.mockReset();
    uploadToFal.mockReset();
    uploadToFal.mockImplementation(
      async (_buffer: Buffer, name: string) => `https://fal.test/${name}`,
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the seed, persona and 81 frames with the swap token, and rehosts the clip and its last frame", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        video_base64: Buffer.from("mp4").toString("base64"),
        last_frame_base64: Buffer.from("png").toString("base64"),
        last_frame_format: "png",
        stats,
      }),
    );
    const outcome = await wan14bClip({
      prompt: "she waves",
      seedFrameUrl: "https://example.com/seed.png",
      personaId: "synth-persona-01",
      toneReferenceUrl: "https://example.com/tone.png",
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://wan14b.test/clip");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer 0123456789abcdef0123456789abcdef",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      persona_id: "synth-persona-01",
      prompt: "she waves",
      image_url: "https://example.com/seed.png",
      num_frames: 81,
      tone_reference_url: "https://example.com/tone.png",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uploadToFal).toHaveBeenCalledWith(
      Buffer.from("mp4"),
      expect.stringMatching(/\.mp4$/),
      "video/mp4",
    );
    expect(uploadToFal).toHaveBeenCalledWith(
      Buffer.from("png"),
      expect.stringMatching(/-last\.png$/),
      "image/png",
    );
    expect(outcome.videoUrl).toMatch(/\.mp4$/);
    expect(outcome.lastFrameUrl).toMatch(/-last\.png$/);
    expect(outcome.report).toMatchObject({
      status: "swapped",
      frames: 81,
      framesWithFace: 80,
      similarityAfter: 0.82,
      fps: 16,
    });
    expect(outcome.costUsd).toBeCloseTo(
      18 * LIVE_TUNABLES.WAN14B_COST_PER_SEC_USD,
    );
  });

  it("refuses without a persona or configuration, before any request", async () => {
    await expect(
      wan14bClip({
        prompt: "p",
        seedFrameUrl: "https://example.com/seed.png",
        personaId: undefined,
      }),
    ).rejects.toThrow("No persona selected");
    envMock.SWAP_TOKEN = undefined;
    await expect(
      wan14bClip({
        prompt: "p",
        seedFrameUrl: "https://example.com/seed.png",
        personaId: "synth-persona-01",
      }),
    ).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a service error so the caller falls back, without retrying", async () => {
    fetchMock.mockResolvedValue(
      new Response("seed gate: seed face does not match the persona", {
        status: 422,
      }),
    );
    await expect(
      wan14bClip({
        prompt: "p",
        seedFrameUrl: "https://example.com/seed.png",
        personaId: "synth-persona-01",
      }),
    ).rejects.toThrow("Premium service responded 422: seed gate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uploadToFal).not.toHaveBeenCalled();
  });

  it("bounds the call below the clip route's own limit", () => {
    expect(WAN14B_BUDGET_MS).toBeLessThan(300_000 / 2);
  });
});
