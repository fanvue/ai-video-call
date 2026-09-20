import {
  falService,
  pollFalQueueUntilComplete,
  type FalQueueSubmitResponse,
} from "./client";
import {
  identityCorrectionRequestSchema,
  identityCorrectionResultSchema,
} from "./schemas";

const NANO_BANANA_EDIT_MODEL_PATH = "fal-ai/nano-banana-2/edit";

export const IDENTITY_CORRECTION_PROMPT =
  "Restore the exact face, hair, skin tone, and body of the FIRST reference image onto the SECOND image. " +
  "Keep the second image's pose, clothing, framing, background, and camera angle completely unchanged — " +
  "only correct her identity and likeness back to the first reference image. Photoreal, single subject, no extra limbs. " +
  "Do not use the first image's clothing or nudity state — if the second image shows her clothed, keep her exactly that clothed; " +
  "if it shows her nude or partially undressed, keep her exactly that nude or undressed. Never add or remove a garment.";

// Generalised from the spike's single-purpose drift corrector: frameGuard's repair pass reuses
// this same edit endpoint with an issue-specific prompt instead of the generic drift prompt.
export const correctFrameIdentityDrift = async ({
  anchorImageUrl,
  frameUrl,
  prompt = IDENTITY_CORRECTION_PROMPT,
  timeoutMs = 30_000,
}: {
  anchorImageUrl: string;
  frameUrl: string;
  prompt?: string;
  timeoutMs?: number;
}): Promise<string> => {
  const body = identityCorrectionRequestSchema.parse({
    prompt,
    image_urls: [anchorImageUrl, frameUrl],
  });

  const submitted = await falService.post<FalQueueSubmitResponse>(
    `/${NANO_BANANA_EDIT_MODEL_PATH}`,
    body,
  );

  const result = await pollFalQueueUntilComplete<unknown>({
    statusUrl: submitted.status_url,
    responseUrl: submitted.response_url,
    timeoutMs,
  });
  const [image] = identityCorrectionResultSchema.parse(result).images;
  if (!image) {
    throw new Error("Identity correction returned no image");
  }
  return image.url;
};
