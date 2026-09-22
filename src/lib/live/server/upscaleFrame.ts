import {
  pollFrameUpscaleUntilComplete,
  submitFrameUpscale,
} from "@/lib/fal/requestFrameUpscale";

const UPSCALE_BUDGET_MS = 15_000;

// fal lists SeedVR2 at $0.001 per output megapixel; a 2x of the 542x988 render is ~2.1 MP.
const UPSCALE_COST_PER_MEGAPIXEL_USD = 0.001;
const FALLBACK_OUTPUT_MEGAPIXELS = (542 * 988 * 4) / 1_000_000;

export type UpscaleResult = {
  url: string;
  costUsd: number;
};

// Best-effort seed restoration between chain clips (see pipeline.ts upscaleChainTailInBackground):
// a failure or timeout just keeps the caller's frame as-is.
export const upscaleFrame = async (
  frameUrl: string,
): Promise<UpscaleResult | null> => {
  try {
    const submitted = await submitFrameUpscale({
      image_url: frameUrl,
      upscale_mode: "factor",
      upscale_factor: 2,
      noise_scale: 0.1,
      output_format: "jpg",
    });
    const result = await pollFrameUpscaleUntilComplete({
      statusUrl: submitted.status_url,
      responseUrl: submitted.response_url,
      timeoutMs: UPSCALE_BUDGET_MS,
    });
    const megapixels =
      result.image.width && result.image.height
        ? (result.image.width * result.image.height) / 1_000_000
        : FALLBACK_OUTPUT_MEGAPIXELS;
    return {
      url: result.image.url,
      costUsd: megapixels * UPSCALE_COST_PER_MEGAPIXEL_USD,
    };
  } catch (error) {
    console.warn("upscaleFrame: upscale failed or timed out", error);
    return null;
  }
};
