import { randomUUID } from "node:crypto";
import {
  extractLastFrameUrl,
  extractMidFrameUrl,
} from "@/lib/fal/extractLastFrame";
import type {
  ClipRequest,
  ClipResult,
  FrameGuardReport,
  GarmentId,
  LiveState,
  ObservedState,
  Pose,
} from "../contract";
import { guardFrame } from "./frameGuard";
import { planClip, typingLeadSecFor } from "./planClip";
import { reconcilePose, reconcileWardrobe } from "./reconcileState";
import { renderBackendFor } from "./renderClip";
import { writeCheckIn, writeReply } from "./writeReply";

// A hold clip is rejected outright on this; a non-hold clip's own wardrobe drift is fixed by
// reconciling state instead (see reconcileState.ts) and is never a rejection reason.
const ANATOMY_ISSUE_RE = /extra person|extra or malformed limbs/;

const FRAME_BUDGET_MS = 15_000;
const GUARD_BUDGET_MS = 8_000;

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

const GARMENT_IDS: GarmentId[] = ["top", "bottom", "bra", "panties"];

type FrameCheck = {
  frameUrl: string | null;
  checked: boolean;
  failedStep: "extractFrame" | "guardFrame" | null;
  observed: ObservedState | null;
  issues: string[];
};

// Extracts + guards one frame of a hold clip. Any failure — extraction timeout, vision
// timeout/refusal, unparseable JSON — comes back `checked: false` so the caller fails closed.
const checkHoldFrame = async (
  videoUrl: string,
  position: "middle" | "last",
  expected: LiveState,
): Promise<FrameCheck> => {
  let frameUrl: string;
  try {
    frameUrl = await withTimeout(
      position === "middle"
        ? extractMidFrameUrl(videoUrl, FRAME_BUDGET_MS)
        : extractLastFrameUrl(videoUrl, FRAME_BUDGET_MS),
      FRAME_BUDGET_MS,
      "extractFrame",
    );
  } catch (error) {
    console.warn(
      `generateClip: ${position} frame extraction failed or timed out on a hold clip`,
      error,
    );
    return {
      frameUrl: null,
      checked: false,
      failedStep: "extractFrame",
      observed: null,
      issues: [],
    };
  }

  let guardOutcome: Pick<FrameGuardReport, "checked" | "issues"> & {
    observed: ObservedState | null;
  };
  try {
    guardOutcome = await withTimeout(
      guardFrame({ frameUrl, expected }),
      GUARD_BUDGET_MS,
      "guardFrame",
    );
  } catch (error) {
    console.warn(
      `generateClip: guard timed out on the ${position} frame of a hold clip`,
      error,
    );
    return {
      frameUrl,
      checked: false,
      failedStep: "guardFrame",
      observed: null,
      issues: [],
    };
  }
  if (!guardOutcome.checked) {
    // guardFrame already logs the vision failure/unparseable JSON internally.
    return {
      frameUrl,
      checked: false,
      failedStep: "guardFrame",
      observed: null,
      issues: [],
    };
  }
  return {
    frameUrl,
    checked: true,
    failedStep: null,
    observed: guardOutcome.observed,
    issues: guardOutcome.issues,
  };
};

const missingGarmentIn = (
  check: FrameCheck,
  expected: LiveState,
): GarmentId | null =>
  GARMENT_IDS.find(
    (id) => expected.wardrobe[id].on && check.observed?.wardrobe[id] === false,
  ) ?? null;

const anatomyIssueIn = (check: FrameCheck): string | null =>
  check.issues.find((issue) => ANATOMY_ISSUE_RE.test(issue)) ?? null;

type HoldVerdict = {
  verdict: "approved" | "rejected";
  rejectReason: string | null;
  observedPose: Pose | undefined;
};

// A hold clip fails closed: an unchecked frame, a garment canon says is worn but is observed bare,
// or an anatomy issue in any frame rejects the whole clip.
const evaluateHoldChecks = (
  frames: Array<{ label: string; check: FrameCheck }>,
  expected: LiveState,
): HoldVerdict => {
  for (const { label, check } of frames) {
    if (!check.checked) {
      return {
        verdict: "rejected",
        rejectReason: `${check.failedStep} failed on the ${label} frame`,
        observedPose: undefined,
      };
    }
  }
  for (const { label, check } of frames) {
    const missing = missingGarmentIn(check, expected);
    if (missing) {
      return {
        verdict: "rejected",
        rejectReason: `${missing} should be on but the ${label} frame shows it absent`,
        observedPose: undefined,
      };
    }
    const anatomyIssue = anatomyIssueIn(check);
    if (anatomyIssue) {
      return {
        verdict: "rejected",
        rejectReason: `${label} frame: ${anatomyIssue}`,
        observedPose: undefined,
      };
    }
  }
  const observedPose = [...frames]
    .reverse()
    .map(({ check }) => check.observed?.pose)
    .find((pose): pose is Pose => pose !== undefined);
  return { verdict: "approved", rejectReason: null, observedPose };
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
  // Hold clip (idle/greeting/checkIn/non-wardrobe act/hold/pose transition) — must be verified before it can play; see checkHoldFrame below.
  const isHoldClip = plan.wardrobeIntent === null && !plan.explicit;

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
  let verifyMs = 0;
  let guardOutcome: Pick<FrameGuardReport, "checked" | "issues"> & {
    observed: ObservedState | null;
  } = {
    checked: false,
    issues: [],
    observed: null,
  };
  let expectedState = plan.expectedState;
  let verdict: "approved" | "rejected" = "approved";
  let rejectReason: string | null = null;

  if (job.kind === "idle") {
    // Idle's frame is never reused as a seed (see pipeline.ts), so it always plays from session.seedFrameUrl; only the midpoint needs checking since start/end are the anchor by construction.
    const verifyStarted = Date.now();
    const midCheck = await checkHoldFrame(
      rendered.videoUrl,
      "middle",
      plan.expectedState,
    );
    verifyMs = Date.now() - verifyStarted;
    seedFrameUrl = session.seedFrameUrl;
    const result = evaluateHoldChecks(
      [{ label: "midpoint", check: midCheck }],
      plan.expectedState,
    );
    verdict = result.verdict;
    rejectReason = result.rejectReason;
    guardOutcome = {
      checked: midCheck.checked,
      issues: midCheck.issues,
      observed: midCheck.observed,
    };
    if (verdict === "approved") {
      expectedState = {
        ...expectedState,
        body: reconcilePose(expectedState.body, result.observedPose),
      };
    }
  } else if (isHoldClip) {
    // Two-frame check: the midpoint catches a garment that slipped mid-clip, even if it settled
    // back by the end; the last frame doubles as this clip's next seed.
    const verifyStarted = Date.now();
    const [midCheck, lastCheck] = await Promise.all([
      checkHoldFrame(rendered.videoUrl, "middle", plan.expectedState),
      checkHoldFrame(rendered.videoUrl, "last", plan.expectedState),
    ]);
    verifyMs = Date.now() - verifyStarted;
    const result = evaluateHoldChecks(
      [
        { label: "midpoint", check: midCheck },
        { label: "last", check: lastCheck },
      ],
      plan.expectedState,
    );
    verdict = result.verdict;
    rejectReason = result.rejectReason;
    seedFrameUrl = lastCheck.frameUrl ?? session.seedFrameUrl;
    guardOutcome = {
      checked: lastCheck.checked,
      issues: lastCheck.issues,
      observed: lastCheck.observed,
    };
    if (verdict === "approved") {
      expectedState = {
        ...expectedState,
        body: reconcilePose(expectedState.body, result.observedPose),
      };
    }
  } else {
    // Non-hold (wardrobe change or explicit act): single last-frame guard, never rejected by wardrobe observation (director's bounded retry handles an unmet removal).
    // Rejected only for extraPeople/extraLimbs when the check ran — unlike hold clips this fails OPEN on an unchecked frame, or a vision refusal would permanently block a legitimately requested explicit clip.
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

    // State follows the frame: whatever the guard actually saw becomes canon, not the prediction —
    // wardrobe only in the request's own direction (see reconcileState.ts), pose unconditionally.
    if (guardOutcome.checked && guardOutcome.observed) {
      expectedState = {
        ...expectedState,
        wardrobe: reconcileWardrobe(
          expectedState.wardrobe,
          guardOutcome.observed.wardrobe,
          plan.wardrobeIntent,
          plan.targetGarment,
        ),
        body: reconcilePose(expectedState.body, guardOutcome.observed.pose),
      };
    }

    const anatomyIssue = guardOutcome.checked
      ? (guardOutcome.issues.find((issue) => ANATOMY_ISSUE_RE.test(issue)) ??
        null)
      : null;
    if (anatomyIssue) {
      verdict = "rejected";
      rejectReason = anatomyIssue;
    }
  }

  const replyOutcome = await replyTextPromise;
  // A rejected clip's dialogue never rewrites canon: only an approved clip's nextWorld is adopted.
  const finalState =
    verdict === "approved" && replyOutcome?.nextWorld
      ? { ...expectedState, world: replyOutcome.nextWorld.slice(0, 420) }
      : expectedState;

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
    // Frame repair was retired with this pass: a hold clip that fails is now rejected and retried
    // as a whole clip instead of pixel-patched, and a non-hold clip is never repaired either.
    repaired: false,
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
    observed: guardOutcome.observed,
    verdict,
    rejectReason,
    timings: { planMs, renderMs, frameMs, guardMs, repairMs: 0, verifyMs },
    costUsd: rendered.costUsd,
  };
};
