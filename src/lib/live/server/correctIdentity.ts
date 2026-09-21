import {
  pollFrameUpscaleUntilComplete,
  submitFrameUpscale,
} from "@/lib/fal/requestFrameUpscale";
import {
  pollIdentityCorrectionUntilComplete,
  submitIdentityCorrection,
} from "@/lib/fal/requestIdentityCorrection";

const CORRECTION_BUDGET_MS = 15_000;
const UPSCALE_BUDGET_MS = 15_000;

// Estimated from typical fal per-call pricing; not confirmed against either model's published rate card.
const IDENTITY_CORRECTION_COST_USD = 0.06;
const FRAME_UPSCALE_COST_USD = 0.03;

const FRAME_UPSCALE_PROMPT =
  "Restore sharpness and fine detail lost to video compression. Do not alter pose, framing, expression, clothing, or background.";

export type IdentityCorrectionResult = {
  correctedFrameUrl: string;
  costUsd: number;
};

// No prompt: face-swap only replaces the face region, so there's no text channel for it to reinterpret the scene through.
const runIdentityEdit = async (
  currentFrameUrl: string,
  anchorFrameUrl: string,
): Promise<string | null> => {
  const submitted = await submitIdentityCorrection({
    base_image_url: currentFrameUrl,
    swap_image_url: anchorFrameUrl,
  });
  const result = await pollIdentityCorrectionUntilComplete({
    statusUrl: submitted.status_url,
    responseUrl: submitted.response_url,
    timeoutMs: CORRECTION_BUDGET_MS,
  });
  return result.image.url;
};

// Best-effort: an upscale failure or timeout just keeps the identity-corrected frame as-is.
const runUpscale = async (frameUrl: string): Promise<string | null> => {
  try {
    const submitted = await submitFrameUpscale({
      image_url: frameUrl,
      prompt: FRAME_UPSCALE_PROMPT,
      upscale_factor: 2,
      creativity: 0.2,
      resemblance: 0.85,
      enable_safety_checker: false,
    });
    const result = await pollFrameUpscaleUntilComplete({
      statusUrl: submitted.status_url,
      responseUrl: submitted.response_url,
      timeoutMs: UPSCALE_BUDGET_MS,
    });
    return result.image.url;
  } catch (error) {
    console.warn(
      "correctIdentity: upscale failed or timed out, keeping the identity-corrected frame",
      error,
    );
    return null;
  }
};

// Fails open: a failed/timed-out identity edit returns null and the caller falls back to the
// uncorrected current frame — this is a periodic quality nudge, not something worth dropping a clip over.
export const correctIdentity = async (
  currentFrameUrl: string,
  anchorFrameUrl: string,
): Promise<IdentityCorrectionResult | null> => {
  try {
    const editedFrameUrl = await runIdentityEdit(
      currentFrameUrl,
      anchorFrameUrl,
    );
    if (!editedFrameUrl) return null;

    const upscaledFrameUrl = await runUpscale(editedFrameUrl);
    const correctedFrameUrl = upscaledFrameUrl ?? editedFrameUrl;
    const costUsd =
      IDENTITY_CORRECTION_COST_USD +
      (upscaledFrameUrl ? FRAME_UPSCALE_COST_USD : 0);

    return { correctedFrameUrl, costUsd };
  } catch (error) {
    console.warn(
      "correctIdentity: identity correction failed or timed out, using the uncorrected frame",
      error,
    );
    return null;
  }
};
