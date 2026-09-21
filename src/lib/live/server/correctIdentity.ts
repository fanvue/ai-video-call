import {
  pollIdentityCorrectionUntilComplete,
  submitIdentityCorrection,
} from "@/lib/fal/requestIdentityCorrection";
import { upscaleFrame } from "./upscaleFrame";

const CORRECTION_BUDGET_MS = 15_000;

// Estimated from typical fal per-call pricing; not confirmed against the model's published rate card.
const IDENTITY_CORRECTION_COST_USD = 0.06;

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

    const upscaled = await upscaleFrame(editedFrameUrl);
    const correctedFrameUrl = upscaled?.url ?? editedFrameUrl;
    const costUsd = IDENTITY_CORRECTION_COST_USD + (upscaled?.costUsd ?? 0);

    return { correctedFrameUrl, costUsd };
  } catch (error) {
    console.warn(
      "correctIdentity: identity correction failed or timed out, using the uncorrected frame",
      error,
    );
    return null;
  }
};
