import { randomUUID } from "node:crypto";
import { extractLastFrameUrl } from "@/lib/fal/extractLastFrame";
import { correctFrameIdentityDrift } from "@/lib/fal/requestFrameIdentityCorrection";
import {
  LIVE_TUNABLES,
  type ClipRequest,
  type ClipResult,
  type FrameGuardReport,
} from "../contract";
import { guardFrame, repairFrame } from "./frameGuard";
import { planClip, typingLeadSecFor } from "./planClip";
import { renderBackendFor } from "./renderClip";
import { writeCheckIn, writeReply } from "./writeReply";

// Periodic re-grounding against the untouched upload, not every clip — cheaper, and keeps the
// correction call off the critical path most turns.
const dueForCorrection = (elapsedSec: number, durationSec: number): boolean =>
  Math.floor(elapsedSec / LIVE_TUNABLES.IDENTITY_ANCHOR_EVERY_SEC) <
  Math.floor(
    (elapsedSec + durationSec) / LIVE_TUNABLES.IDENTITY_ANCHOR_EVERY_SEC,
  );

export const generateClip = async (
  request: ClipRequest,
): Promise<ClipResult> => {
  const { session, job, backend, speechMode } = request;

  const planStarted = Date.now();
  const plan = planClip({ session, job, speechMode });
  const planMs = Date.now() - planStarted;

  const renderStarted = Date.now();
  const videoBackend = renderBackendFor(backend);
  const renderPromise = videoBackend.render({
    prompt: plan.prompt,
    seedFrameUrl: session.seedFrameUrl,
    durationSec: plan.durationSec,
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
          })
        : job.kind === "reply"
          ? writeReply({
              transcript: session.transcript,
              requestText: job.text,
              physical: plan.prompt,
              creator: session.creator,
              channel: job.channel,
              world: session.state.world,
            })
          : Promise.resolve(null);

  // Render is the one hard-fail path — everything after this point degrades instead of throwing.
  const rendered = await renderPromise;
  const renderMs = Date.now() - renderStarted;

  const frameStarted = Date.now();
  let seedFrameUrl = session.seedFrameUrl;
  try {
    seedFrameUrl = await extractLastFrameUrl(rendered.videoUrl);
  } catch (error) {
    console.warn(
      "generateClip: last-frame extraction failed, reusing previous seed frame",
      error,
    );
  }
  const frameMs = Date.now() - frameStarted;

  if (dueForCorrection(session.elapsedSec, plan.durationSec)) {
    try {
      seedFrameUrl = await correctFrameIdentityDrift({
        anchorImageUrl: session.anchorFrameUrl,
        frameUrl: seedFrameUrl,
        timeoutMs: 15_000,
      });
    } catch (error) {
      console.warn(
        "generateClip: periodic identity anchor correction failed, keeping drifted frame",
        error,
      );
    }
  }

  const guardStarted = Date.now();
  const guardOutcome = await guardFrame({
    frameUrl: seedFrameUrl,
    expected: plan.expectedState,
  });
  const guardMs = Date.now() - guardStarted;

  const repairStarted = Date.now();
  let repaired = false;
  if (guardOutcome.checked && guardOutcome.issues.length > 0) {
    try {
      seedFrameUrl = await repairFrame({
        frameUrl: seedFrameUrl,
        anchorFrameUrl: session.anchorFrameUrl,
        expected: plan.expectedState,
        issues: guardOutcome.issues,
      });
      repaired = true;
    } catch (error) {
      console.warn(
        "generateClip: frame repair failed, keeping guarded-but-unrepaired frame",
        error,
      );
    }
  }
  const repairMs = Date.now() - repairStarted;

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
    state: finalState,
    reply,
    followUps: plan.followUps,
    guard,
    timings: { planMs, renderMs, frameMs, guardMs, repairMs },
    costUsd: rendered.costUsd,
  };
};
