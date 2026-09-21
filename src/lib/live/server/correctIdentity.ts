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

// Image-edit (not video-generation) nudging only identity, with pose/scene explicitly locked — avoids the pose/scene reset that feeding the anchor into video generation causes (see renderClip.ts's regression note).
const IDENTITY_CORRECTION_PROMPT =
  "The first image is the current frame; the second image is a face/body identity reference from earlier " +
  "in the same session. Correct only the first image's facial features, hair colour, skin tone, and build " +
  "to match the second image's identity. Keep the first image's pose, framing, expression, clothing, " +
  "props, and background exactly as they are — change nothing else.";

const FRAME_UPSCALE_PROMPT =
  "Restore sharpness and fine detail lost to video compression. Do not alter pose, framing, expression, clothing, or background.";

export type IdentityCorrectionResult = {
  correctedFrameUrl: string;
  costUsd: number;
};

const runIdentityEdit = async (
  currentFrameUrl: string,
  anchorFrameUrl: string,
): Promise<string | null> => {
  const submitted = await submitIdentityCorrection({
    prompt: IDENTITY_CORRECTION_PROMPT,
    image_urls: [currentFrameUrl, anchorFrameUrl],
    num_images: 1,
    output_format: "jpeg",
    safety_tolerance: "6",
  });
  const result = await pollIdentityCorrectionUntilComplete({
    statusUrl: submitted.status_url,
    responseUrl: submitted.response_url,
    timeoutMs: CORRECTION_BUDGET_MS,
  });
  return result.images[0]?.url ?? null;
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
