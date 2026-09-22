import { z } from "zod";
import { env } from "@/env";
import { uploadToFal } from "@/lib/fal/uploadImage";
import { LIVE_TUNABLES, type ClipSwapReport } from "../contract";

// Cold container (60s+) + a 15s clip at ~20ms/frame fit inside this.
export const SWAP_BUDGET_MS = 150_000;
// The greeting gates the whole join, so it waits less than a mid-session clip; prod showed 23s for a 15s greeting against a still-starting container, and the unswapped fallback costs a fal frame extract on top.
export const SWAP_GREETING_BUDGET_MS = 40_000;

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
    enhanced: z.boolean().optional(),
    enhance_ms: z.number().int().min(0).optional(),
    sharpness_before: z.number().nullable().optional(),
    sharpness_after: z.number().nullable().optional(),
  }),
});

export type SwapClipOutcome = {
  videoUrl: string;
  lastFrameUrl: string;
  report: ClipSwapReport;
  costUsd: number;
};

// The reference is the same anchor for every clip of a session, so fetch it once per warm lambda.
const referenceCache = new Map<string, Promise<string>>();

const fetchAsDataUri = (url: string): Promise<string> => {
  const cached = referenceCache.get(url);
  if (cached) {
    return cached;
  }
  const pending = fetchReference(url).catch((error: unknown) => {
    referenceCache.delete(url);
    throw error;
  });
  if (referenceCache.size >= 16) {
    referenceCache.delete(referenceCache.keys().next().value as string);
  }
  referenceCache.set(url, pending);
  return pending;
};

const fetchReference = async (url: string): Promise<string> => {
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
  budgetMs = SWAP_BUDGET_MS,
  jobKind = "unknown",
}: {
  videoUrl: string;
  referenceImageUrl: string;
  budgetMs?: number;
  jobKind?: string;
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
    signal: AbortSignal.timeout(budgetMs),
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
    `swapClip: kind=${jobKind} serviceMs=${serviceMs} (swap ${stats.swap_ms}) rehostMs=${Date.now() - stamp} frames=${stats.frames} enhanceMs=${stats.enhance_ms ?? 0} sharpness=${stats.sharpness_before ?? "?"}->${stats.sharpness_after ?? "?"}`,
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
