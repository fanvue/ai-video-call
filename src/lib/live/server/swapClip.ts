import { z } from "zod";
import { env } from "@/env";
import { uploadToFal } from "@/lib/fal/uploadImage";
import { LIVE_TUNABLES, type ClipSwapReport } from "../contract";

// Cold container (60s+) + a 15s clip at ~20ms/frame fit inside this.
export const SWAP_BUDGET_MS = 150_000;
// The greeting gates the whole join, so it waits less than a mid-session clip: a warm swap of a 15 s greeting is 6 s, and past this the container is cold (93 s measured) and the reference-to-video greeting already carries the identity, so the unswapped fallback (one fal frame extract) is the faster join.
export const SWAP_GREETING_BUDGET_MS = 20_000;

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
    download_ms: z.number().int().min(0).optional(),
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

// Sends a rendered turbo clip through the self-hosted swap service (services/swap) and rehosts
// the swapped mp4 and its last frame on fal storage so the client and the next render can fetch them.
const RETRYABLE_SWAP_STATUSES = new Set([408, 500, 502, 503, 504]);
// Healthy swaps return in ~4.5 s; Modal has held a lost input for 36 s before a 500, so a second request races the first after this.
const SWAP_HEDGE_MS = 8_000;

class SwapServiceError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Swap service responded ${status}: ${detail.slice(0, 200)}`);
  }
}

export const swapClip = async ({
  videoUrl,
  personaId,
  budgetMs = SWAP_BUDGET_MS,
  jobKind = "unknown",
  swapModel,
}: {
  videoUrl: string;
  // The swap source is an allowlisted manifest persona only; the session's upload drives generation and never reaches the swap.
  personaId: string | undefined;
  budgetMs?: number;
  jobKind?: string;
  swapModel?: string;
}): Promise<SwapClipOutcome> => {
  if (!personaId) {
    throw new Error("No persona selected, the clip plays unswapped");
  }
  if (!env.SWAP_SERVICE_URL || !env.SWAP_TOKEN) {
    throw new Error("Swap service is not configured");
  }
  const startedAt = Date.now();
  const body = JSON.stringify({
    video_url: videoUrl,
    persona_id: personaId,
    ...(swapModel ? { model: swapModel } : {}),
  });
  const controllers: AbortController[] = [];
  const attempt = async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(new URL("/swapClip", env.SWAP_SERVICE_URL), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SWAP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(Math.max(1, budgetMs - (Date.now() - startedAt))),
      ]),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new SwapServiceError(response.status, detail);
    }
    return { response, controller };
  };
  const first = attempt();
  let second = false;
  const hedge = new Promise<Awaited<ReturnType<typeof attempt>>>(
    (resolve, reject) => {
      const launch = (reason: string) => {
        console.warn(`swapClip: kind=${jobKind} second request, ${reason}`);
        second = true;
        attempt().then(resolve, reject);
      };
      const timer = setTimeout(
        () => launch("first not back yet"),
        SWAP_HEDGE_MS,
      );
      first.then(
        () => clearTimeout(timer),
        (error: unknown) => {
          clearTimeout(timer);
          if (second) return;
          if (
            error instanceof SwapServiceError &&
            RETRYABLE_SWAP_STATUSES.has(error.status) &&
            Date.now() - startedAt < budgetMs / 2
          ) {
            launch(`first failed ${error.status}`);
          } else {
            reject(error);
          }
        },
      );
    },
  );
  const { response, controller: winner } = await Promise.any([
    first,
    hedge,
  ]).catch((error: unknown) => {
    throw error instanceof AggregateError ? error.errors.at(-1) : error;
  });
  // Only the loser is cancelled; aborting the winner would cut its body read.
  for (const controller of controllers) {
    if (controller !== winner) controller.abort();
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
      `swap-${stamp}-last.png`,
      "image/png",
    ),
  ]);
  const { stats } = parsed;
  console.log(
    `swapClip: kind=${jobKind} serviceMs=${serviceMs} (swap ${stats.swap_ms}) rehostMs=${Date.now() - stamp} downloadMs=${stats.download_ms ?? 0} frames=${stats.frames} enhanceMs=${stats.enhance_ms ?? 0} sharpness=${stats.sharpness_before ?? "?"}->${stats.sharpness_after ?? "?"}`,
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

// A warm container answers in about 1 s (download plus one ffmpeg tail decode); fal's ffmpeg-api took 5 to 6 s for the same frame.
export const LAST_FRAME_BUDGET_MS = 8_000;

const lastFrameResponseSchema = z.object({
  last_frame_base64: z.string().min(1),
});

// The clip's raw last frame from the swap service, rehosted for the next render.
export const swapServiceLastFrame = async ({
  videoUrl,
  toneReferenceUrl,
  budgetMs = LAST_FRAME_BUDGET_MS,
}: {
  videoUrl: string;
  toneReferenceUrl?: string;
  budgetMs?: number;
}): Promise<string> => {
  if (!env.SWAP_SERVICE_URL || !env.SWAP_TOKEN) {
    throw new Error("Swap service is not configured");
  }
  const startedAt = Date.now();
  const response = await fetch(new URL("/lastFrame", env.SWAP_SERVICE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SWAP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      video_url: videoUrl,
      ...(toneReferenceUrl ? { tone_reference_url: toneReferenceUrl } : {}),
    }),
    signal: AbortSignal.timeout(budgetMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Swap service responded ${response.status}: ${detail.slice(0, 200)}`,
    );
  }
  const parsed = lastFrameResponseSchema.parse(await response.json());
  const stamp = Date.now();
  const url = await uploadToFal(
    Buffer.from(parsed.last_frame_base64, "base64"),
    `seed-${stamp}.png`,
    "image/png",
  );
  console.log(
    `lastFrame: serviceMs=${stamp - startedAt} rehostMs=${Date.now() - stamp}`,
  );
  return url;
};

// A warm container answers in about 1.5 s; 6 s leaves the raw /lastFrame fallback (8 s) inside generateClip's 15 s frame budget.
const SWAP_TAIL_BUDGET_MS = 6_000;

const swapTailResponseSchema = z.object({
  last_frame_base64: z.string().min(1),
  stats: z.object({
    swap_ms: z.number().int().min(0),
    had_face: z.boolean(),
    similarity_before: z.number().nullable(),
    similarity_after: z.number().nullable(),
    download_ms: z.number().int().min(0).optional(),
    enhanced: z.boolean().optional(),
    enhance_ms: z.number().int().min(0).optional(),
    sharpness_before: z.number().nullable().optional(),
    sharpness_after: z.number().nullable().optional(),
  }),
});

// Swaps and finishes only the clip's last frame, through the same persona gate and finishing as swapClip, so a chain
// clip's seed carries the persona's identity forward instead of the raw render's own compounding drift.
export const swapTail = async ({
  videoUrl,
  personaId,
  budgetMs = SWAP_TAIL_BUDGET_MS,
  jobKind = "unknown",
}: {
  videoUrl: string;
  // Same gate as swapClip: an allowlisted manifest persona only, never a session upload.
  personaId: string | undefined;
  budgetMs?: number;
  jobKind?: string;
}): Promise<{ lastFrameUrl: string; costUsd: number }> => {
  if (!personaId) {
    throw new Error("No persona selected, the clip plays unswapped");
  }
  if (!env.SWAP_SERVICE_URL || !env.SWAP_TOKEN) {
    throw new Error("Swap service is not configured");
  }
  const startedAt = Date.now();
  const response = await fetch(new URL("/swapTail", env.SWAP_SERVICE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SWAP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ video_url: videoUrl, persona_id: personaId }),
    signal: AbortSignal.timeout(budgetMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Swap service responded ${response.status}: ${detail.slice(0, 200)}`,
    );
  }
  const parsed = swapTailResponseSchema.parse(await response.json());
  const stamp = Date.now();
  const lastFrameUrl = await uploadToFal(
    Buffer.from(parsed.last_frame_base64, "base64"),
    `swap-${stamp}-tail.png`,
    "image/png",
  );
  const { stats } = parsed;
  console.log(
    `swapTail: kind=${jobKind} serviceMs=${stamp - startedAt} (swap ${stats.swap_ms}) rehostMs=${Date.now() - stamp} downloadMs=${stats.download_ms ?? 0} face=${stats.had_face} similarity=${stats.similarity_before}->${stats.similarity_after} sharpness=${stats.sharpness_before ?? "?"}->${stats.sharpness_after ?? "?"}`,
  );
  return {
    lastFrameUrl,
    costUsd: (stats.swap_ms / 1000) * LIVE_TUNABLES.SWAP_COST_PER_SEC_USD,
  };
};

export const pendingSwapReport = (): ClipSwapReport => ({
  status: "pending",
  swapMs: 0,
  frames: 0,
  framesWithFace: 0,
  msPerFrame: 0,
  similarityBefore: null,
  similarityAfter: null,
  restored: false,
  reason: null,
});

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

// Covers a cold container (about 11 s); it runs beside the upload and vision capture, off the join's critical path.
const FACE_CROP_BUDGET_MS = 25_000;

const faceCropResponseSchema = z.object({ crop_base64: z.string().min(1) });

// Head-only crop of the upload, rehosted, for reference-to-video's identity image.
export const swapServiceFaceCrop = async (
  referenceDataUri: string,
): Promise<string> => {
  if (!env.SWAP_SERVICE_URL || !env.SWAP_TOKEN) {
    throw new Error("Swap service is not configured");
  }
  const response = await fetch(new URL("/faceCrop", env.SWAP_SERVICE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SWAP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reference_image: referenceDataUri }),
    signal: AbortSignal.timeout(FACE_CROP_BUDGET_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Swap service responded ${response.status}: ${detail.slice(0, 200)}`,
    );
  }
  const parsed = faceCropResponseSchema.parse(await response.json());
  return uploadToFal(
    Buffer.from(parsed.crop_base64, "base64"),
    `identity-${Date.now()}.jpg`,
    "image/jpeg",
  );
};
