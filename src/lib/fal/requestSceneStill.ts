import type { z } from "zod";
import {
  falService,
  pollFalQueueUntilComplete,
  type FalQueueSubmitResponse,
} from "./client";
import { sceneStillRequestSchema, sceneStillResultSchema } from "./schemas";

const SCENE_STILL_MODEL_PATH = "fal-ai/bytedance/seedream/v4/edit";

export const submitSceneStill = async (
  payload: z.infer<typeof sceneStillRequestSchema>,
) => {
  const body = sceneStillRequestSchema.parse(payload);
  return falService.post<FalQueueSubmitResponse>(
    `/${SCENE_STILL_MODEL_PATH}`,
    body,
  );
};

export const pollSceneStillUntilComplete = async (args: {
  statusUrl: string;
  responseUrl: string;
  timeoutMs?: number;
}) => {
  const result = await pollFalQueueUntilComplete<unknown>(args);
  return sceneStillResultSchema.parse(result);
};
