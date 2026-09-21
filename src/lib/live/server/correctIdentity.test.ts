import { beforeEach, describe, expect, it, vi } from "vitest";

const submitIdentityCorrection = vi.fn();
const pollIdentityCorrectionUntilComplete = vi.fn();
vi.mock("@/lib/fal/requestIdentityCorrection", () => ({
  submitIdentityCorrection: (...args: unknown[]) =>
    submitIdentityCorrection(...args),
  pollIdentityCorrectionUntilComplete: (...args: unknown[]) =>
    pollIdentityCorrectionUntilComplete(...args),
}));

const submitFrameUpscale = vi.fn();
const pollFrameUpscaleUntilComplete = vi.fn();
vi.mock("@/lib/fal/requestFrameUpscale", () => ({
  submitFrameUpscale: (...args: unknown[]) => submitFrameUpscale(...args),
  pollFrameUpscaleUntilComplete: (...args: unknown[]) =>
    pollFrameUpscaleUntilComplete(...args),
}));

const { correctIdentity } = await import("./correctIdentity");

const currentFrameUrl = "https://example.com/current.jpg";
const anchorFrameUrl = "https://example.com/anchor.jpg";

beforeEach(() => {
  submitIdentityCorrection.mockReset();
  pollIdentityCorrectionUntilComplete.mockReset();
  submitFrameUpscale.mockReset();
  pollFrameUpscaleUntilComplete.mockReset();

  submitIdentityCorrection.mockResolvedValue({
    status_url: "https://example.com/status",
    response_url: "https://example.com/response",
  });
  submitFrameUpscale.mockResolvedValue({
    status_url: "https://example.com/status",
    response_url: "https://example.com/response",
  });
});

describe("correctIdentity", () => {
  it("returns the upscaled, identity-corrected frame and sums both costs when both calls succeed", async () => {
    pollIdentityCorrectionUntilComplete.mockResolvedValue({
      image: { url: "https://example.com/edited.jpg" },
    });
    pollFrameUpscaleUntilComplete.mockResolvedValue({
      image: { url: "https://example.com/upscaled.jpg" },
    });

    const result = await correctIdentity(currentFrameUrl, anchorFrameUrl);

    expect(submitIdentityCorrection).toHaveBeenCalledWith({
      base_image_url: currentFrameUrl,
      swap_image_url: anchorFrameUrl,
    });
    expect(submitFrameUpscale).toHaveBeenCalledWith(
      expect.objectContaining({ image_url: "https://example.com/edited.jpg" }),
    );
    expect(result).toEqual({
      correctedFrameUrl: "https://example.com/upscaled.jpg",
      costUsd: 0.09,
    });
  });

  it("falls back to the edited frame, without the upscale cost, when upscaling fails", async () => {
    pollIdentityCorrectionUntilComplete.mockResolvedValue({
      image: { url: "https://example.com/edited.jpg" },
    });
    pollFrameUpscaleUntilComplete.mockRejectedValue(new Error("upscale down"));

    const result = await correctIdentity(currentFrameUrl, anchorFrameUrl);

    expect(result).toEqual({
      correctedFrameUrl: "https://example.com/edited.jpg",
      costUsd: 0.06,
    });
  });

  it("returns null and never attempts an upscale when identity correction itself fails", async () => {
    pollIdentityCorrectionUntilComplete.mockRejectedValue(
      new Error("content_policy_violation"),
    );

    const result = await correctIdentity(currentFrameUrl, anchorFrameUrl);

    expect(result).toBeNull();
    expect(submitFrameUpscale).not.toHaveBeenCalled();
  });
});
