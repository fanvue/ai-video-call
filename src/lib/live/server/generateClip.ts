import { randomUUID } from "node:crypto";
import {
  extractLastFrameUrl,
  extractMidFrameUrl,
} from "@/lib/fal/extractLastFrame";
import {
  LIVE_TUNABLES,
  type ClipRequest,
  type ClipResult,
  type ClipSwapReport,
  type FrameGuardReport,
  type GarmentId,
  type LiveState,
  type ObservedState,
  type Pose,
} from "../contract";
import { guardFrame } from "./frameGuard";
import { planClip, typingLeadSecFor } from "./planClip";
import { reconcilePose, reconcileWardrobe } from "./reconcileState";
import { renderBackendFor } from "./renderClip";
import { STAGE_ROOM_BY_SCENE } from "./sceneRooms";
import {
  failedSwapReport,
  SWAP_BUDGET_MS,
  SWAP_GREETING_BUDGET_MS,
  swapClip,
} from "./swapClip";
import { writeCheckIn, writeReply } from "./writeReply";

const ANATOMY_ISSUE_RE = /extra person|extra or malformed limbs/;
const IDENTITY_ISSUE_RE = /identity drift/;
const COLOR_ISSUE_RE = /^(top|bottom|bra|panties) color drifted/;

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

// Extracts + guards one frame. Any failure — extraction timeout, vision timeout/refusal,
// unparseable JSON — comes back `checked: false`; the caller decides fail-open vs fail-closed.
const checkFrame = async (
  videoUrl: string,
  position: "middle" | "last",
  expected: LiveState,
  anchorFrameUrl: string,
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
      `generateClip: ${position} frame extraction failed or timed out`,
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
      guardFrame({ frameUrl, expected, anchorFrameUrl }),
      GUARD_BUDGET_MS,
      "guardFrame",
    );
  } catch (error) {
    console.warn(
      `generateClip: guard timed out on the ${position} frame`,
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

type GarmentMismatch = {
  garment: GarmentId;
  expectedState: "on" | "off";
  observedState: "present" | "absent";
};

// Any non-target garment disagreeing with canon in EITHER direction is a mismatch — a canon-OFF garment observed back on is the drift that used to seed the next clip's prompt with a contradiction. "unknown" is never a mismatch.
const garmentMismatchIn = (
  check: FrameCheck,
  expected: LiveState,
  targetGarment: GarmentId | undefined,
): GarmentMismatch | null => {
  for (const id of GARMENT_IDS) {
    if (id === targetGarment) continue;
    const seen = check.observed?.wardrobe[id];
    if (typeof seen !== "boolean") continue;
    const wanted = expected.wardrobe[id].on;
    if (seen !== wanted) {
      return {
        garment: id,
        expectedState: wanted ? "on" : "off",
        observedState: seen ? "present" : "absent",
      };
    }
  }
  return null;
};

const anatomyIssueIn = (check: FrameCheck): string | null =>
  check.issues.find((issue) => ANATOMY_ISSUE_RE.test(issue)) ?? null;

const identityIssueIn = (check: FrameCheck): string | null =>
  check.issues.find((issue) => IDENTITY_ISSUE_RE.test(issue)) ?? null;

// Same target-garment exemption as garmentMismatchIn above.
const colorIssueIn = (
  check: FrameCheck,
  targetGarment: GarmentId | undefined,
): string | null =>
  check.issues.find((issue) => {
    const match = issue.match(COLOR_ISSUE_RE);
    return match !== null && match[1] !== targetGarment;
  }) ?? null;

type FrameVerdict = {
  verdict: "approved" | "rejected";
  rejectReason: string | null;
  observedPose: Pose | undefined;
};

// Single place the symmetric frame-guard rule lives, for all four clip kinds. `failClosed` rejects outright on an unchecked frame (idle/hold); otherwise an unchecked frame just warns and is skipped, so a vision refusal can't permanently block a legitimately requested clip.
const evaluateFrameChecks = ({
  checks,
  expected,
  targetGarment,
  failClosed,
}: {
  checks: Array<{ label: string; check: FrameCheck }>;
  expected: LiveState;
  targetGarment?: GarmentId;
  failClosed: boolean;
}): FrameVerdict => {
  for (const { label, check } of checks) {
    if (check.checked) continue;
    // No frame never fails open: canon would advance while the seed stays on the old frame.
    if (failClosed || check.frameUrl === null) {
      return {
        verdict: "rejected",
        rejectReason: `${check.failedStep} failed on the ${label} frame`,
        observedPose: undefined,
      };
    }
    console.warn(
      `generateClip: ${check.failedStep} failed on the ${label} frame, skipping check for this clip (fail-open)`,
    );
  }
  for (const { label, check } of checks) {
    if (!check.checked) continue;
    const mismatch = garmentMismatchIn(check, expected, targetGarment);
    if (mismatch) {
      return {
        verdict: "rejected",
        rejectReason: `${label} frame: ${mismatch.garment} should be ${mismatch.expectedState} but shows ${mismatch.observedState}`,
        observedPose: undefined,
      };
    }
    // A colour mismatch on a present garment rejects exactly like a presence mismatch.
    const colorIssue = colorIssueIn(check, targetGarment);
    if (colorIssue) {
      return {
        verdict: "rejected",
        rejectReason: `${label} frame: ${colorIssue}`,
        observedPose: undefined,
      };
    }
    const identityIssue = identityIssueIn(check);
    if (identityIssue) {
      return {
        verdict: "rejected",
        rejectReason: `${label} frame: ${identityIssue}`,
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
  const observedPose = [...checks]
    .reverse()
    .map(({ check }) => check.observed?.pose)
    .find((pose): pose is Pose => pose !== undefined);
  return { verdict: "approved", rejectReason: null, observedPose };
};

export const generateClip = async (
  request: ClipRequest,
): Promise<ClipResult> => {
  const { session, job, backend, speechMode, useIdentityReference } = request;

  const planStarted = Date.now();
  const plan = planClip({ session, job, speechMode, backend });
  const planMs = Date.now() - planStarted;

  const greetingFromReference =
    backend === "swap" &&
    job.kind === "greeting" &&
    session.seedFrameUrl === session.anchorFrameUrl;
  const videoBackend = renderBackendFor(backend, { greetingFromReference });
  // Only idle loops on the anchor; every other job chains forward from a real generated frame, single-image-seed style — pinning a hold's end frame to the seed never stopped it from drifting mid-clip, it only masked the seam for the next clip.
  // The greeting also loops when its seed is a staged in-scene still (seed differs from the identity photo), so the idles pre-stocked from that frame stay playable after it. On the raw upload it chains: the photo's clothes and room contradict the prompt and every loop back to it popped.
  const greetingLoops =
    job.kind === "greeting" && session.seedFrameUrl !== session.anchorFrameUrl;
  const isAnchoredLoop =
    (job.kind === "idle" || greetingLoops) && videoBackend.supportsEndFrame;
  // Idle never seeds the next clip even where it cannot loop (reference backend); an anchored loop returns to its seed.
  const keepsSessionSeed = job.kind === "idle" || isAnchoredLoop;
  // Hold clip (idle/greeting/checkIn/non-wardrobe act/hold/pose transition) — must be verified before it can play; see checkFrame below.
  const isHoldClip = plan.wardrobeIntent === null && !plan.explicit;
  // Explicit act with no wardrobe change of its own (useProp, twerk, ...) — checked like a hold clip but fails open on an unchecked frame; see evaluateFrameChecks.
  const isExplicitNonWardrobe = plan.wardrobeIntent === null && plan.explicit;

  const renderStarted = Date.now();
  // The reference model has no first frame to inherit the room from, so the prompt establishes it and pins the upload to identity only.
  const prompt = greetingFromReference
    ? `Image 1 is the woman's identity only: face, hair, skin tone and build. Do not copy its pose, clothing or background. Scene: ${STAGE_ROOM_BY_SCENE[session.creator.sceneId]} ${plan.prompt}`
    : plan.prompt;
  const renderPromise = videoBackend.render({
    prompt,
    seedFrameUrl: session.seedFrameUrl,
    durationSec: plan.durationSec,
    endFrameUrl: isAnchoredLoop ? session.seedFrameUrl : undefined,
    identityReferenceUrl: useIdentityReference
      ? session.anchorFrameUrl
      : undefined,
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
  console.log(
    `generateClip: renderMs=${renderMs} kind=${job.kind} backend=${backend} dualRef=${useIdentityReference}`,
  );

  // Swap backend: the swapped clip replaces turbo's output for playback, checks and the next seed.
  let videoUrl = rendered.videoUrl;
  let costUsd = rendered.costUsd;
  let swapReport: ClipSwapReport | undefined;
  let swappedLastFrameUrl: string | null = null;
  if (backend === "swap") {
    const swapStarted = Date.now();
    try {
      const swapped = await swapClip({
        videoUrl,
        referenceImageUrl: session.anchorFrameUrl,
        budgetMs:
          job.kind === "greeting" ? SWAP_GREETING_BUDGET_MS : SWAP_BUDGET_MS,
        jobKind: job.kind,
      });
      videoUrl = swapped.videoUrl;
      costUsd += swapped.costUsd;
      swapReport = swapped.report;
      swappedLastFrameUrl = swapped.lastFrameUrl;
    } catch (error) {
      // Quality feature, not a guard: the unswapped clip plays and the studio overlay shows the miss.
      console.warn(
        "generateClip: swap failed, playing the unswapped clip",
        error,
      );
      swapReport = failedSwapReport(Date.now() - swapStarted, error);
    }
    console.log(
      `generateClip: swap status=${swapReport.status} swapMs=${swapReport.swapMs} frames=${swapReport.frames} msPerFrame=${swapReport.msPerFrame} similarity=${swapReport.similarityBefore}->${swapReport.similarityAfter}`,
    );
  }

  let seedFrameUrl = session.seedFrameUrl;
  // No longer split per step: every path now runs its frame check(s) through checkFrame/evaluateFrameChecks and reports total time as verifyMs.
  const frameMs = 0;
  const guardMs = 0;
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

  if (!LIVE_TUNABLES.VERIFY_FRAMES) {
    // Vision guard off: no rejection, no reconciliation, canon is the plan. Only the last frame is extracted, since the next clip needs a seed; an anchored loop returns to its seed and needs none.
    if (!keepsSessionSeed) {
      const verifyStarted = Date.now();
      try {
        seedFrameUrl =
          swappedLastFrameUrl ??
          (await withTimeout(
            extractLastFrameUrl(videoUrl, FRAME_BUDGET_MS),
            FRAME_BUDGET_MS,
            "extractFrame",
          ));
      } catch (error) {
        console.warn("generateClip: last frame extraction failed", error);
        verdict = "rejected";
        rejectReason =
          "last frame: extraction failed, no seed for the next clip";
      }
      verifyMs = Date.now() - verifyStarted;
    }
  } else if (keepsSessionSeed) {
    // An anchored loop's frame is never reused as a seed (see pipeline.ts), so it always plays from session.seedFrameUrl; only the midpoint needs checking since start/end are the anchor by construction.
    const verifyStarted = Date.now();
    const midCheck = await checkFrame(
      videoUrl,
      "middle",
      plan.expectedState,
      session.anchorFrameUrl,
    );
    verifyMs = Date.now() - verifyStarted;
    seedFrameUrl = session.seedFrameUrl;
    const result = evaluateFrameChecks({
      checks: [{ label: "midpoint", check: midCheck }],
      expected: plan.expectedState,
      failClosed: true,
    });
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
      checkFrame(
        videoUrl,
        "middle",
        plan.expectedState,
        session.anchorFrameUrl,
      ),
      checkFrame(videoUrl, "last", plan.expectedState, session.anchorFrameUrl),
    ]);
    verifyMs = Date.now() - verifyStarted;
    const result = evaluateFrameChecks({
      checks: [
        { label: "midpoint", check: midCheck },
        { label: "last", check: lastCheck },
      ],
      expected: plan.expectedState,
      failClosed: true,
    });
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
  } else if (isExplicitNonWardrobe) {
    // Same two-frame shape as a hold clip, but fails open on an unchecked frame — a persistent vision refusal must not permanently block a legitimately requested explicit clip.
    const verifyStarted = Date.now();
    const [midCheck, lastCheck] = await Promise.all([
      checkFrame(
        videoUrl,
        "middle",
        plan.expectedState,
        session.anchorFrameUrl,
      ),
      checkFrame(videoUrl, "last", plan.expectedState, session.anchorFrameUrl),
    ]);
    verifyMs = Date.now() - verifyStarted;
    const result = evaluateFrameChecks({
      checks: [
        { label: "midpoint", check: midCheck },
        { label: "last", check: lastCheck },
      ],
      expected: plan.expectedState,
      failClosed: false,
    });
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
    // Wardrobe clip (removeGarment/addGarment): both frames checked, fail closed; the target garment is exempt from mismatch rejection and reconciled from observation instead (director.ts's bounded retry).
    const verifyStarted = Date.now();
    const [midCheck, lastCheck] = await Promise.all([
      checkFrame(
        videoUrl,
        "middle",
        plan.expectedState,
        session.anchorFrameUrl,
      ),
      checkFrame(videoUrl, "last", plan.expectedState, session.anchorFrameUrl),
    ]);
    verifyMs = Date.now() - verifyStarted;
    const result = evaluateFrameChecks({
      checks: [
        { label: "midpoint", check: midCheck },
        { label: "last", check: lastCheck },
      ],
      expected: plan.expectedState,
      targetGarment: plan.targetGarment,
      failClosed: true,
    });
    verdict = result.verdict;
    rejectReason = result.rejectReason;
    // An "unknown" reading on the target garment can't confirm the change it was checking for.
    if (
      verdict === "approved" &&
      plan.targetGarment &&
      lastCheck.checked &&
      typeof lastCheck.observed?.wardrobe[plan.targetGarment] !== "boolean"
    ) {
      verdict = "rejected";
      rejectReason = `last frame: target garment ${plan.targetGarment} unknown`;
    }
    seedFrameUrl = lastCheck.frameUrl ?? session.seedFrameUrl;
    guardOutcome = {
      checked: lastCheck.checked,
      issues: lastCheck.issues,
      observed: lastCheck.observed,
    };
    if (verdict === "approved") {
      expectedState = {
        ...expectedState,
        wardrobe: lastCheck.observed
          ? reconcileWardrobe(
              expectedState.wardrobe,
              lastCheck.observed.wardrobe,
              plan.targetGarment,
            )
          : expectedState.wardrobe,
        body: reconcilePose(expectedState.body, result.observedPose),
      };
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
    videoUrl,
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
    costUsd,
    swap: swapReport,
  };
};
