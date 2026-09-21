import { randomUUID } from "node:crypto";
import { extractLastFrameUrl } from "@/lib/fal/extractLastFrame";
import type { ClipRequest, ClipResult, FrameGuardReport } from "../contract";
import { guardFrame, repairFrame } from "./frameGuard";
import { planClip, typingLeadSecFor } from "./planClip";
import { renderBackendFor } from "./renderClip";
import { writeCheckIn, writeReply } from "./writeReply";

// Hard per-step budgets on the chained critical path. A step that blows its budget degrades
// (keeps the best frame it has so far) instead of stalling the whole clip.
const FRAME_BUDGET_MS = 15_000;
const GUARD_BUDGET_MS = 8_000;
const REPAIR_BUDGET_MS = 15_000;

class StepTimeoutError extends Error {}

// Races `promise` against a budget; the underlying call has no cancel hook, so it keeps running unobserved on timeout.
const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  step: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StepTimeoutError(`${step} exceeded ${ms}ms budget`)),
      ms,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
};

export const generateClip = async (
  request: ClipRequest,
): Promise<ClipResult> => {
  const { session, job, backend, speechMode } = request;

  const planStarted = Date.now();
  const plan = planClip({ session, job, speechMode, backend });
  const planMs = Date.now() - planStarted;

  const videoBackend = renderBackendFor(backend);
  // Only idle loops on the anchor; every other job chains forward from a real generated frame, single-image-seed style — pinning a hold's end frame to the seed never stopped it from drifting mid-clip, it only masked the seam for the next clip.
  const isAnchoredLoop = job.kind === "idle" && videoBackend.supportsEndFrame;
  // Repair only fixes the seed for the NEXT render, not this clip's already-baked-in video, so skip it mid-chain to save latency.
  const isIntermediateBeat = job.kind === "reply" || job.kind === "beat";

  const renderStarted = Date.now();
  const renderPromise = videoBackend.render({
    prompt: plan.prompt,
    seedFrameUrl: session.seedFrameUrl,
    durationSec: plan.durationSec,
    endFrameUrl: isAnchoredLoop ? session.seedFrameUrl : undefined,
  });

  const replyTextPromise: Promise<{ text: string; nextWorld: string } | null> =
    !plan.needsReplyText
      ? Promise.resolve(null)
      : job.kind === "checkIn"
        ? writeCheckIn({
            transcript: session.transcript,
            creator: session.creator,
            channel: job.channel,
            world: session.state.world,
            speechMode,
          })
        : job.kind === "reply"
          ? writeReply({
              transcript: session.transcript,
              requestText: job.text,
              physical: plan.prompt,
              creator: session.creator,
              channel: job.channel,
              world: session.state.world,
              from: job.from,
              handle: job.handle,
              speechMode,
            })
          : Promise.resolve(null);

  // Render is the one hard-fail path — everything after this point degrades instead of throwing.
  const rendered = await renderPromise;
  const renderMs = Date.now() - renderStarted;

  let seedFrameUrl = session.seedFrameUrl;
  let frameMs = 0;
  let guardMs = 0;
  let repairMs = 0;
  let repaired = false;
  let guardOutcome: Pick<FrameGuardReport, "checked" | "issues"> = {
    checked: false,
    issues: [],
  };

  if (isAnchoredLoop) {
    // Loops start and end on the same anchor frame by construction — nothing to extract or guard.
    seedFrameUrl = session.seedFrameUrl;
  } else if (job.kind === "idle") {
    // Idle's result frame is matched for playback by the anchor it was rendered FROM, never reused
    // as a seed (see pipeline.ts), so extracting/guarding/correcting it is pure wasted latency.
    seedFrameUrl = session.seedFrameUrl;
  } else {
    const frameStarted = Date.now();
    try {
      seedFrameUrl = await withTimeout(
        extractLastFrameUrl(rendered.videoUrl, FRAME_BUDGET_MS),
        FRAME_BUDGET_MS,
        "extractLastFrameUrl",
      );
    } catch (error) {
      console.warn(
        "generateClip: last-frame extraction failed or timed out, reusing previous seed frame",
        error,
      );
    }
    frameMs = Date.now() - frameStarted;

    // Every non-loop clip is guarded now, mid-chain (reply/beat) included: drift compounds across
    // beats, and repair only fires when the (cheap) guard actually flags something.
    const guardStarted = Date.now();
    try {
      guardOutcome = await withTimeout(
        guardFrame({ frameUrl: seedFrameUrl, expected: plan.expectedState }),
        GUARD_BUDGET_MS,
        "guardFrame",
      );
    } catch (error) {
      console.warn(
        "generateClip: frame guard timed out, skipping check for this clip",
        error,
      );
    }
    guardMs = Date.now() - guardStarted;

    const repairStarted = Date.now();
    if (
      !isIntermediateBeat &&
      guardOutcome.checked &&
      guardOutcome.issues.length > 0
    ) {
      try {
        seedFrameUrl = await withTimeout(
          repairFrame({
            frameUrl: seedFrameUrl,
            anchorFrameUrl: session.anchorFrameUrl,
            expected: plan.expectedState,
            issues: guardOutcome.issues,
          }),
          REPAIR_BUDGET_MS,
          "repairFrame",
        );
        repaired = true;
      } catch (error) {
        console.warn(
          "generateClip: frame repair failed or timed out, keeping guarded-but-unrepaired frame",
          error,
        );
      }
    }
    repairMs = Date.now() - repairStarted;
  }

  const replyOutcome = await replyTextPromise;
  const finalState = replyOutcome?.nextWorld
    ? { ...plan.expectedState, world: replyOutcome.nextWorld.slice(0, 420) }
    : plan.expectedState;

  const reply: ClipResult["reply"] = plan.fixedReplyText
    ? {
        text: plan.fixedReplyText,
        channel: plan.replyDraft?.channel ?? "chat",
        typingLeadSec: plan.replyDraft?.typingLeadSec ?? 0,
      }
    : replyOutcome && plan.replyDraft
      ? {
          text: replyOutcome.text,
          channel: plan.replyDraft.channel,
          typingLeadSec: Math.min(
            plan.durationSec,
            typingLeadSecFor(replyOutcome.text),
          ),
        }
      : null;

  const guard: FrameGuardReport = {
    checked: guardOutcome.checked,
    issues: guardOutcome.issues,
    repaired,
  };

  return {
    clipId: randomUUID(),
    jobKind: job.kind,
    videoUrl: rendered.videoUrl,
    durationSec: plan.durationSec,
    seedFrameUrl,
    loops: isAnchoredLoop,
    state: finalState,
    reply,
    followUps: plan.followUps,
    guard,
    timings: { planMs, renderMs, frameMs, guardMs, repairMs },
    costUsd: rendered.costUsd,
  };
};
