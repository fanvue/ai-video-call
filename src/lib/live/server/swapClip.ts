import { z } from "zod";
import { env } from "@/env";
import { uploadToFal } from "@/lib/fal/uploadImage";
import { LIVE_TUNABLES, type ClipSwapReport } from "../contract";

// Cold container (~25s) + model warm-up + a 15s clip at ~50ms/frame all fit well inside this.
const SWAP_BUDGET_MS = 150_000;

const swapServiceResponseSchema = z.object({
  video_base64: z.string().min(1),
  last_frame_base64: z.string().min(1),
  stats: z.object({
    frames: z.number().int().min(0),
    frames_with_face: z.number().int().min(0),
    fps: z.number().min(0),
    swap_ms: z.number().int().min(0),
    ms_per_frame: z.number().min(0),
    similarity_before: z.number().nullable(),
    similarity_after: z.number().nullable(),
    restored: z.boolean(),
  }),
});

export type SwapClipOutcome = {
  videoUrl: string;
  lastFrameUrl: string;
  report: ClipSwapReport;
  costUsd: number;
};

const fetchAsDataUri = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`reference fetch failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${bytes.toString("base64")}`;
};

// Sends a rendered turbo clip through the self-hosted swap service (services/swap) and rehosts
// the swapped mp4 and its last frame on fal storage so the client and the next render can fetch them.
export const swapClip = async ({
  videoUrl,
  referenceImageUrl,
}: {
  videoUrl: string;
  referenceImageUrl: string;
}): Promise<SwapClipOutcome> => {
  if (!env.SWAP_SERVICE_URL || !env.SWAP_TOKEN) {
    throw new Error("Swap service is not configured");
  }
  const startedAt = Date.now();
  const response = await fetch(new URL("/swapClip", env.SWAP_SERVICE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SWAP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      video_url: videoUrl,
      reference_image: await fetchAsDataUri(referenceImageUrl),
    }),
    signal: AbortSignal.timeout(SWAP_BUDGET_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Swap service responded ${response.status}: ${detail.slice(0, 200)}`,
    );
  }
  const parsed = swapServiceResponseSchema.parse(await response.json());
  const stamp = Date.now();
  const serviceMs = stamp - startedAt;
  const [swappedVideoUrl, lastFrameUrl] = await Promise.all([
    uploadToFal(
      Buffer.from(parsed.video_base64, "base64"),
      `swap-${stamp}.mp4`,
      "video/mp4",
    ),
    uploadToFal(
      Buffer.from(parsed.last_frame_base64, "base64"),
      `swap-${stamp}-last.jpg`,
      "image/jpeg",
    ),
  ]);
  const { stats } = parsed;
  console.log(
    `swapClip: serviceMs=${serviceMs} (swap ${stats.swap_ms}) rehostMs=${Date.now() - stamp} frames=${stats.frames}`,
  );
  return {
    videoUrl: swappedVideoUrl,
    lastFrameUrl,
    report: {
      status: "swapped",
      swapMs: stats.swap_ms,
      frames: stats.frames,
      framesWithFace: stats.frames_with_face,
      msPerFrame: stats.ms_per_frame,
      similarityBefore: stats.similarity_before,
      similarityAfter: stats.similarity_after,
      restored: stats.restored,
      reason: null,
    },
    costUsd: (stats.swap_ms / 1000) * LIVE_TUNABLES.SWAP_COST_PER_SEC_USD,
  };
};

export const failedSwapReport = (
  swapMs: number,
  error: unknown,
): ClipSwapReport => ({
  status: "failed",
  swapMs,
  frames: 0,
  framesWithFace: 0,
  msPerFrame: 0,
  similarityBefore: null,
  similarityAfter: null,
  restored: false,
  reason: (error instanceof Error ? error.message : String(error)).slice(
    0,
    300,
  ),
});
