import { z } from "zod";
import { env } from "@/env";
import { uploadToFal } from "@/lib/fal/uploadImage";
import { LIVE_TUNABLES, type ClipSwapReport } from "../contract";

// A warm clip is about 16 s on one H100 (bench: 12.4 s denoise + 2.7 s decode + swap + encode); a cold container (about 90 s) runs past this and the clip falls back to swap while it boots.
export const WAN14B_BUDGET_MS = 40_000;

const wan14bResponseSchema = z.object({
  video_base64: z.string().min(1),
  last_frame_base64: z.string().min(1),
  stats: z.object({
    render_ms: z.number().int().min(0),
    decode_ms: z.number().int().min(0),
    swap_ms: z.number().int().min(0),
    encode_ms: z.number().int().min(0),
    total_ms: z.number().int().min(0),
    num_frames: z.number().int().min(1),
    fps: z.number().min(1),
    frames_with_face: z.number().int().min(0).optional(),
    tone_locked: z.boolean(),
    similarity_after: z.number().nullable(),
  }),
});

export type Wan14bClipOutcome = {
  videoUrl: string;
  lastFrameUrl: string;
  report: ClipSwapReport;
  costUsd: number;
  totalMs: number;
};

export const wan14bClip = async ({
  prompt,
  seedFrameUrl,
  personaId,
  toneReferenceUrl,
  jobKind = "unknown",
  budgetMs = WAN14B_BUDGET_MS,
}: {
  prompt: string;
  // The greeting's upload or the previous clip's swapped last frame; the service's seed gate refuses a face that is not the persona.
  seedFrameUrl: string;
  personaId: string | undefined;
  toneReferenceUrl?: string;
  jobKind?: string;
  budgetMs?: number;
}): Promise<Wan14bClipOutcome> => {
  if (!personaId) {
    throw new Error("No persona selected, Premium needs one");
  }
  if (!env.WAN14B_SERVICE_URL || !env.SWAP_TOKEN) {
    throw new Error("Premium service is not configured");
  }
  const startedAt = Date.now();
  // One request, no hedge: a second 14B render would take the other H100 and double the cost for the same clip.
  const response = await fetch(new URL("/clip", env.WAN14B_SERVICE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SWAP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      persona_id: personaId,
      prompt,
      image_url: seedFrameUrl,
      num_frames: LIVE_TUNABLES.WAN14B_NUM_FRAMES,
      ...(toneReferenceUrl ? { tone_reference_url: toneReferenceUrl } : {}),
    }),
    signal: AbortSignal.timeout(budgetMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Premium service responded ${response.status}: ${detail.slice(0, 200)}`,
    );
  }
  const parsed = wan14bResponseSchema.parse(await response.json());
  const stamp = Date.now();
  const [videoUrl, lastFrameUrl] = await Promise.all([
    uploadToFal(
      Buffer.from(parsed.video_base64, "base64"),
      `wan14b-${stamp}.mp4`,
      "video/mp4",
    ),
    uploadToFal(
      Buffer.from(parsed.last_frame_base64, "base64"),
      `wan14b-${stamp}-last.png`,
      "image/png",
    ),
  ]);
  const { stats } = parsed;
  console.log(
    `wan14bClip: kind=${jobKind} serviceMs=${stamp - startedAt} (render ${stats.render_ms} decode ${stats.decode_ms} swap ${stats.swap_ms} encode ${stats.encode_ms}) rehostMs=${Date.now() - stamp} frames=${stats.num_frames} toneLocked=${stats.tone_locked} similarity=${stats.similarity_after}`,
  );
  return {
    videoUrl,
    lastFrameUrl,
    report: {
      status: "swapped",
      swapMs: stats.swap_ms,
      frames: stats.num_frames,
      framesWithFace: stats.frames_with_face ?? 0,
      msPerFrame: stats.swap_ms / stats.num_frames,
      similarityBefore: null,
      similarityAfter: stats.similarity_after,
      restored: false,
      reason: null,
      fps: stats.fps,
    },
    costUsd: (stats.total_ms / 1000) * LIVE_TUNABLES.WAN14B_COST_PER_SEC_USD,
    totalMs: Date.now() - startedAt,
  };
};
