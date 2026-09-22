import {
  pollFrameUpscaleUntilComplete,
  submitFrameUpscale,
} from "@/lib/fal/requestFrameUpscale";

const UPSCALE_BUDGET_MS = 15_000;

// Estimated from typical fal per-call pricing; not confirmed against the model's published rate card.
export const FRAME_UPSCALE_COST_USD = 0.03;

const FRAME_UPSCALE_PROMPT =
  "Restore sharpness and fine detail lost to video compression. Do not alter pose, framing, expression, clothing, or background.";

export type UpscaleResult = {
  url: string;
  costUsd: number;
};

// Best-effort: shared by the periodic identity-correction pass (correctIdentity.ts) and the
// per-clip seed upscale (generateClip.ts) — a failure or timeout just keeps the caller's frame as-is.
export const upscaleFrame = async (
  frameUrl: string,
): Promise<UpscaleResult | null> => {
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
    return { url: result.image.url, costUsd: FRAME_UPSCALE_COST_USD };
  } catch (error) {
    console.warn("upscaleFrame: upscale failed or timed out", error);
    return null;
  }
};
