import { NextResponse } from "next/server";
import { z } from "zod";
import { uploadToFal } from "@/lib/fal/uploadImage";
import { getCurrentUser } from "@/lib/fanvue";
import {
  clipRequestSchema,
  creatorProfileSchema,
  inputChannelSchema,
  intentParserSchema,
  liveSessionSnapshotSchema,
  liveStateSchema,
  speechModeSchema,
  swapModelFor,
  swapProfileSchema,
  transcriptEntrySchema,
} from "@/lib/live/contract";
import { correctActionTypos } from "@/lib/live/server/actionTypos";
import { generateClip } from "@/lib/live/server/generateClip";
import { MINOR_CUE_RE } from "@/lib/live/server/longliveAction";
import { planLongLiveSettle } from "@/lib/live/server/longlivePrompt";
import { SWAP_BUDGET_MS, swapClip } from "@/lib/live/server/swapClip";

// Render plus the full clip swap, which can include a cold swap container.
export const maxDuration = 300;

// Same cap as longliveObserve: one 480x832 canvas JPEG is well under it.
const MAX_FRAME_BASE64 = 1_500_000;

const falUrl = z
  .url()
  .refine(
    (value) =>
      new URL(value).protocol === "https:" &&
      new URL(value).hostname.endsWith(".fal.media"),
    "expected a fal.media URL",
  );

// services/longlive/protocol.py's allowlist; a restart URL outside it would close the whole stream with 4400.
const isLongLiveImageUrl = (value: string): boolean => {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    (host === "fal.media" ||
      host.endsWith(".fal.media") ||
      (host === "storage.googleapis.com" &&
        url.pathname.startsWith("/falserverless/")))
  );
};

const bodySchema = z.object({
  creator: creatorProfileSchema,
  state: liveStateSchema,
  transcript: z.array(transcriptEntrySchema).max(40),
  requestId: z.string().min(1).max(128),
  text: z.string().min(1).max(2000),
  channel: inputChannelSchema,
  paid: z.boolean().optional(),
  speechMode: speechModeSchema.default("text"),
  intentParser: intentParserSchema.default("regex"),
  swapProfile: swapProfileSchema.optional(),
  elapsedSec: liveSessionSnapshotSchema.shape.elapsedSec,
  // The stream frame the clip starts from.
  frameBase64: z.string().min(1).max(MAX_FRAME_BASE64),
  // The untouched upload: the swap's identity reference.
  anchorFrameUrl: falUrl,
});

// LongLive hands an action it cannot perform to swap mode's clip path: render from the current stream frame, finish the swap, return the clip and the scene to restart the stream in.
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const {
    creator,
    state,
    transcript,
    requestId,
    text,
    channel,
    paid,
    speechMode,
    intentParser,
    swapProfile,
    elapsedSec,
    frameBase64,
    anchorFrameUrl,
  } = parsed.data;
  // The prompt route never hands these off; refusing here keeps the clip path closed to them too.
  if (MINOR_CUE_RE.test(correctActionTypos(text))) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const seedFrameUrl = await uploadToFal(
      Buffer.from(frameBase64, "base64"),
      `longlive-handoff-${Date.now()}.jpg`,
      "image/jpeg",
    );
    const clip = await generateClip(
      clipRequestSchema.parse({
        session: {
          creator,
          state,
          seedFrameUrl,
          anchorFrameUrl,
          elapsedSec,
          transcript,
        },
        job: {
          kind: "reply",
          requestId,
          text,
          channel,
          ...(paid !== undefined ? { paid } : {}),
        },
        backend: "swap",
        speechMode,
        swapProfile,
        intentParser,
      }),
    );
    if (clip.verdict === "rejected") {
      throw new Error(`clip rejected: ${clip.rejectReason ?? "unknown"}`);
    }
    let videoUrl = clip.videoUrl;
    let lastFrameUrl = clip.seedFrameUrl;
    // Two-phase swap: the clip is still unswapped, so finish it here the way /api/live/swap does, but fail closed.
    if (clip.swap?.status === "pending") {
      const swapped = await swapClip({
        videoUrl: clip.videoUrl,
        referenceImageUrl: anchorFrameUrl,
        budgetMs: SWAP_BUDGET_MS,
        jobKind: "reply",
        swapModel: swapModelFor(swapProfile),
      });
      videoUrl = swapped.videoUrl;
      lastFrameUrl = swapped.lastFrameUrl;
    } else if (clip.swap?.status !== "swapped") {
      throw new Error(`swap ${clip.swap?.status ?? "missing"}`);
    }
    if (!isLongLiveImageUrl(lastFrameUrl)) {
      throw new Error("last frame is not on an allowed host");
    }
    return NextResponse.json({
      videoUrl,
      lastFrameUrl,
      state: clip.state,
      // The clip is ground truth for what she wears, so the restarted stream names it.
      settlePrompt: planLongLiveSettle(creator, clip.state, true),
    });
  } catch (error) {
    console.warn("live/longliveHandoff: handoff clip failed", error);
    return NextResponse.json({ error: "Handoff clip failed" }, { status: 502 });
  }
}
