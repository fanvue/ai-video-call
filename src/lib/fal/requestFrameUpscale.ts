import { z } from "zod";
import {
  falService,
  pollFalQueueUntilComplete,
  type FalQueueSubmitResponse,
} from "./client";
import { frameUpscaleRequestSchema, frameUpscaleResultSchema } from "./schemas";

const FRAME_UPSCALE_MODEL_PATH = "fal-ai/clarity-upscaler";

export const submitFrameUpscale = async (
  payload: z.infer<typeof frameUpscaleRequestSchema>,
) => {
  const body = frameUpscaleRequestSchema.parse({
    ...payload,
    enable_safety_checker: false,
  });
  return falService.post<FalQueueSubmitResponse>(
    `/${FRAME_UPSCALE_MODEL_PATH}`,
    body,
  );
};

export const pollFrameUpscaleUntilComplete = async (args: {
  statusUrl: string;
  responseUrl: string;
  timeoutMs?: number;
}) => {
  const result = await pollFalQueueUntilComplete<unknown>(args);
  return frameUpscaleResultSchema.parse(result);
};
