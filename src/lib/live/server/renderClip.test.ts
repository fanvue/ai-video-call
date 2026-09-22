import { beforeEach, describe, expect, it, vi } from "vitest";

const submitH3MaxReferenceVideoGeneration = vi.fn();
const pollH3MaxReferenceVideoUntilComplete = vi.fn();
vi.mock("@/lib/fal/requestH3MaxReferenceVideo", () => ({
  submitH3MaxReferenceVideoGeneration: (...args: unknown[]) =>
    submitH3MaxReferenceVideoGeneration(...args),
  pollH3MaxReferenceVideoUntilComplete: (...args: unknown[]) =>
    pollH3MaxReferenceVideoUntilComplete(...args),
}));

const submitH3MaxVideoGeneration = vi.fn();
const pollH3MaxVideoUntilComplete = vi.fn();
vi.mock("@/lib/fal/requestH3MaxVideo", () => ({
  submitH3MaxVideoGeneration: (...args: unknown[]) =>
    submitH3MaxVideoGeneration(...args),
  pollH3MaxVideoUntilComplete: (...args: unknown[]) =>
    pollH3MaxVideoUntilComplete(...args),
}));

const { referenceBackend, renderBackendFor, turboBackend } =
  await import("./renderClip");

describe("referenceBackend.render", () => {
  beforeEach(() => {
    submitH3MaxReferenceVideoGeneration.mockReset();
    pollH3MaxReferenceVideoUntilComplete.mockReset();
    submitH3MaxReferenceVideoGeneration.mockResolvedValue({
      status_url: "https://fal.test/status",
      response_url: "https://fal.test/response",
    });
    pollH3MaxReferenceVideoUntilComplete.mockResolvedValue({
      video: { url: "https://example.com/out.mp4" },
      seed: 1,
    });
  });

  it("passes both the untouched upload and the seed frame as role-labeled references when they differ", async () => {
    await referenceBackend.render({
      prompt: "she waves",
      seedFrameUrl: "https://example.com/seed.jpg",
      durationSec: 10,
      identityReferenceUrl: "https://example.com/upload.jpg",
    });

    const call = submitH3MaxReferenceVideoGeneration.mock.calls[0][0];
    expect(call.reference_image_urls).toEqual([
      "https://example.com/upload.jpg",
      "https://example.com/seed.jpg",
    ]);
    expect(call.prompt).toMatch(/^Image 1 is for facial identity/);
    expect(call.prompt).toContain("she waves");
  });

  it("falls back to a single reference and the plain prompt when there is no distinct upload (e.g. the greeting)", async () => {
    await referenceBackend.render({
      prompt: "she waves",
      seedFrameUrl: "https://example.com/seed.jpg",
      durationSec: 10,
      identityReferenceUrl: "https://example.com/seed.jpg",
    });

    const call = submitH3MaxReferenceVideoGeneration.mock.calls[0][0];
    expect(call.reference_image_urls).toEqual(["https://example.com/seed.jpg"]);
    expect(call.prompt).toBe("she waves");
  });

  it("falls back to a single reference when no identityReferenceUrl is given", async () => {
    await referenceBackend.render({
      prompt: "she waves",
      seedFrameUrl: "https://example.com/seed.jpg",
      durationSec: 10,
    });

    const call = submitH3MaxReferenceVideoGeneration.mock.calls[0][0];
    expect(call.reference_image_urls).toEqual(["https://example.com/seed.jpg"]);
    expect(call.prompt).toBe("she waves");
  });
});

describe("turboBackend.render", () => {
  beforeEach(() => {
    submitH3MaxVideoGeneration.mockReset();
    pollH3MaxVideoUntilComplete.mockReset();
    submitH3MaxVideoGeneration.mockResolvedValue({
      status_url: "https://fal.test/status",
      response_url: "https://fal.test/response",
    });
    pollH3MaxVideoUntilComplete.mockResolvedValue({
      video: { url: "https://example.com/out.mp4" },
      seed: 1,
    });
  });

  it("ignores identityReferenceUrl; it only ever seeds from a single image", async () => {
    await turboBackend.render({
      prompt: "she waves",
      seedFrameUrl: "https://example.com/seed.jpg",
      durationSec: 10,
      identityReferenceUrl: "https://example.com/upload.jpg",
    });

    const call = submitH3MaxVideoGeneration.mock.calls[0][0];
    expect(call.image_url).toBe("https://example.com/seed.jpg");
    expect(call.prompt).toBe("she waves");
  });
});

describe("renderBackendFor", () => {
  it("routes lucy to the turbo clip backend — lucy only restyles turbo's own output", () => {
    expect(renderBackendFor("lucy")).toBe(turboBackend);
  });

  it("routes swap to the turbo clip backend for the same reason", () => {
    expect(renderBackendFor("swap")).toBe(turboBackend);
    expect(renderBackendFor("swap", { greetingFromReference: false })).toBe(
      turboBackend,
    );
  });

  it("routes a swap greeting off a raw upload to reference-to-video, which sets the scene from the prompt", () => {
    expect(renderBackendFor("swap", { greetingFromReference: true })).toBe(
      referenceBackend,
    );
    expect(renderBackendFor("turbo", { greetingFromReference: true })).toBe(
      turboBackend,
    );
  });

  it("routes turbo and reference to themselves", () => {
    expect(renderBackendFor("turbo")).toBe(turboBackend);
    expect(renderBackendFor("reference")).toBe(referenceBackend);
  });

  it("only the reference backend takes a second identity reference", () => {
    expect(turboBackend.supportsIdentityReference).toBe(false);
    expect(referenceBackend.supportsIdentityReference).toBe(true);
  });

  it("throws for director — it never reaches the clip pipeline", () => {
    expect(() => renderBackendFor("director")).toThrow(/live-stream backend/);
  });
});
