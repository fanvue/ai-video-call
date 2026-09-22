import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/fanvue";
import {
  failedSwapReport,
  SWAP_BUDGET_MS,
  SWAP_GREETING_BUDGET_MS,
  swapClip,
} from "@/lib/live/server/swapClip";

// A queued full-clip swap can sit behind two fillers on the one warm container.
export const maxDuration = 180;

// Only fal-hosted renders and reference frames pass through to the swap service.
const falUrl = z
  .url()
  .refine(
    (value) =>
      new URL(value).protocol === "https:" &&
      new URL(value).hostname.endsWith(".fal.media"),
    "expected a fal.media URL",
  );

const bodySchema = z.object({
  videoUrl: falUrl,
  referenceImageUrl: falUrl,
  jobKind: z.enum(["greeting", "idle", "checkIn", "reply", "beat"]),
});

// Second phase of the swap: the clip already came back from /api/live/clip unswapped with a swapped tail as the next seed; this finishes the clip itself before the client plays it. Fails open to the unswapped clip with a failed report.
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
  const { videoUrl, referenceImageUrl, jobKind } = parsed.data;
  const startedAt = Date.now();
  try {
    const swapped = await swapClip({
      videoUrl,
      referenceImageUrl,
      budgetMs:
        jobKind === "greeting" ? SWAP_GREETING_BUDGET_MS : SWAP_BUDGET_MS,
      jobKind,
    });
    return NextResponse.json({
      videoUrl: swapped.videoUrl,
      lastFrameUrl: swapped.lastFrameUrl,
      costUsd: swapped.costUsd,
      report: swapped.report,
    });
  } catch (error) {
    console.warn(`live/swap: ${jobKind} swap failed, playing unswapped`, error);
    return NextResponse.json({
      videoUrl,
      costUsd: 0,
      report: failedSwapReport(Date.now() - startedAt, error),
    });
  }
}
