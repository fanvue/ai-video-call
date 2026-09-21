import { z } from "zod";
import {
  falService,
  pollFalQueueUntilComplete,
  type FalQueueSubmitResponse,
} from "./client";
import {
  identityCorrectionRequestSchema,
  identityCorrectionResultSchema,
} from "./schemas";

const IDENTITY_CORRECTION_MODEL_PATH = "fal-ai/flux-pro/kontext/max/multi";

export const submitIdentityCorrection = async (
  payload: z.infer<typeof identityCorrectionRequestSchema>,
) => {
  const body = identityCorrectionRequestSchema.parse({
    ...payload,
    safety_tolerance: "6",
  });
  return falService.post<FalQueueSubmitResponse>(
    `/${IDENTITY_CORRECTION_MODEL_PATH}`,
    body,
  );
};

export const pollIdentityCorrectionUntilComplete = async (args: {
  statusUrl: string;
  responseUrl: string;
  timeoutMs?: number;
}) => {
  const result = await pollFalQueueUntilComplete<unknown>(args);
  return identityCorrectionResultSchema.parse(result);
};
