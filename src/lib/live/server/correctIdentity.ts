import {
  pollIdentityCorrectionUntilComplete,
  submitIdentityCorrection,
} from "@/lib/fal/requestIdentityCorrection";

const CORRECTION_BUDGET_MS = 15_000;

// Estimated from typical fal image-edit pricing; not confirmed against nano-banana-2's published rate card.
const IDENTITY_CORRECTION_COST_USD = 0.04;

// Image-edit (not video-generation) nudging only identity, with pose/scene explicitly locked — avoids the pose/scene reset that feeding the anchor into video generation causes (see renderClip.ts's regression note).
const IDENTITY_CORRECTION_PROMPT =
  "The first image is the current frame; the second image is a face/body identity reference from earlier " +
  "in the same session. Correct only the first image's facial features, hair colour, skin tone, and build " +
  "to match the second image's identity. Keep the first image's pose, framing, expression, clothing, " +
  "props, and background exactly as they are — change nothing else.";

export type IdentityCorrectionResult = {
  correctedFrameUrl: string;
  costUsd: number;
};

// Fails open: a failed/timed-out correction returns null and the caller falls back to the
// uncorrected current frame — this is a periodic quality nudge, not something worth dropping a clip over.
export const correctIdentity = async (
  currentFrameUrl: string,
  anchorFrameUrl: string,
): Promise<IdentityCorrectionResult | null> => {
  try {
    const submitted = await submitIdentityCorrection({
      prompt: IDENTITY_CORRECTION_PROMPT,
      image_urls: [currentFrameUrl, anchorFrameUrl],
      num_images: 1,
      output_format: "jpeg",
    });
    const result = await pollIdentityCorrectionUntilComplete({
      statusUrl: submitted.status_url,
      responseUrl: submitted.response_url,
      timeoutMs: CORRECTION_BUDGET_MS,
    });
    const correctedFrameUrl = result.images[0]?.url;
    if (!correctedFrameUrl) return null;
    return { correctedFrameUrl, costUsd: IDENTITY_CORRECTION_COST_USD };
  } catch (error) {
    console.warn(
      "correctIdentity: identity correction failed or timed out, using the uncorrected frame",
      error,
    );
    return null;
  }
};
