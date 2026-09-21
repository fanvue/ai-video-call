import {
  falService,
  pollFalQueueUntilComplete,
  type FalQueueSubmitResponse,
} from "./client";
import { extractFrameRequestSchema, extractFrameResultSchema } from "./schemas";

const FFMPEG_EXTRACT_FRAME_MODEL_PATH = "fal-ai/ffmpeg-api/extract-frame";

// Serverless replacement for the pandora monorepo's local-ffmpeg + sharp + S3 last-frame extraction (extractFrameToBuffer.ts) — see the port report's BLOCKED section for why.
// fal only takes a frame_type position ("first"|"middle"|"last"), not a timestamp, so "midpoint" below means frame_type: "middle".
const extractFrame = async (
  videoUrl: string,
  frameType: "first" | "middle" | "last",
  timeoutMs: number,
): Promise<string> => {
  const body = extractFrameRequestSchema.parse({
    video_url: videoUrl,
    frame_type: frameType,
  });

  const submitted = await falService.post<FalQueueSubmitResponse>(
    `/${FFMPEG_EXTRACT_FRAME_MODEL_PATH}`,
    body,
  );

  const result = await pollFalQueueUntilComplete<unknown>({
    statusUrl: submitted.status_url,
    responseUrl: submitted.response_url,
    timeoutMs,
  });
  const [image] = extractFrameResultSchema.parse(result).images;
  if (!image) {
    throw new Error("Frame extraction returned no image");
  }
  return image.url;
};

export const extractLastFrameUrl = (
  videoUrl: string,
  timeoutMs = 15_000,
): Promise<string> => extractFrame(videoUrl, "last", timeoutMs);

// Used by the hold-clip frame guard to check a frame partway through the clip, not just the end.
export const extractMidFrameUrl = (
  videoUrl: string,
  timeoutMs = 15_000,
): Promise<string> => extractFrame(videoUrl, "middle", timeoutMs);
