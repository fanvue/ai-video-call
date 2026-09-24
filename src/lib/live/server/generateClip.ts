import { randomUUID } from "node:crypto";
import {
  extractLastFrameUrl,
  extractMidFrameUrl,
} from "@/lib/fal/extractLastFrame";
import {
  LIVE_TUNABLES,
  stateFrameKey,
  swapRecipeFor,
  type ClipPremiumReport,
  type ClipRequest,
  type ClipResult,
  type ClipSwapReport,
  type FrameGuardReport,
  type GarmentId,
  type LiveState,
  type ObservedState,
  type Pose,
} from "../contract";
import { captureRoom } from "./captureRoom";
import { guardFrame } from "./frameGuard";
import { planClip, typingLeadSecFor } from "./planClip";
import { reconcilePose, reconcileWardrobe } from "./reconcileState";
import { llmIntentsFor } from "./requestIntents";
import { renderBackendFor } from "./renderClip";
import { STAGE_ROOM_BY_SCENE } from "./sceneRooms";
import {
  failedSwapReport,
  pendingSwapReport,
  SWAP_BUDGET_MS,
  swapClip,
  swapFailureReason,
  swapGreetingBudgetMsFor,
  swapServiceLastFrame,
  swapTail,
} from "./swapClip";
import { wan14bClip, type Wan14bClipOutcome } from "./wan14bClip";
import { writeCheckIn, writeReply } from "./writeReply";

const ANATOMY_ISSUE_RE = /extra person|extra or malformed limbs/;
const IDENTITY_ISSUE_RE = /identity drift/;
const COLOR_ISSUE_RE = /^(top|bottom|bra|panties) color drifted/;

const FRAME_BUDGET_MS = 15_000;
const GUARD_BUDGET_MS = 8_000;
// One vision read on the greeting; past this the greeting ships with its preset ROOM text rather than hold the first clip.
const ROOM_CAPTURE_BUDGET_MS = LIVE_TUNABLES.ROOM_CAPTURE_BUDGET_MS;

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
  // Two-phase swap only: the unswapped clip's url as soon as it renders, so the client can start the full swap while the seed swap and checks still run.
  onRendered?: (videoUrl: string) => void,
): Promise<ClipResult> => {
  const { session, job, speechMode, useIdentityReference } = request;
  // Premium idles stay on swap: they loop on the anchor, which Wan cannot (no end frame), and a 16 s render is too slow for a filler.
  let backend =
    request.backend === "wan14b" && job.kind === "idle"
      ? "swap"
      : request.backend;

  const planStarted = Date.now();
  const parsedIntents =
    job.kind === "reply"
      ? await llmIntentsFor(job.text, session.state, request.intentParser)
      : undefined;
  let plan = planClip({ session, job, speechMode, backend, parsedIntents });
  const planMs = Date.now() - planStarted;

  // Started before the render so a Premium clip, and its swap fallback, write her reply alongside it.
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

  const renderStarted = Date.now();
  // Premium: Wan renders from the seed and returns the swapped clip and its tone-locked last frame, so /swapTail and the client's clip swap are skipped. Fails open to the swap path for this clip.
  let premiumClip: Wan14bClipOutcome | null = null;
  let premium: ClipPremiumReport | undefined;
  if (backend === "wan14b") {
    try {
      premiumClip = await wan14bClip({
        prompt: plan.prompt,
        seedFrameUrl: session.seedFrameUrl,
        personaId: request.personaId,
        toneReferenceUrl: session.toneFrameUrl,
        jobKind: job.kind,
      });
      premium = {
        status: "rendered",
        wanMs: premiumClip.totalMs,
        reason: null,
      };
    } catch (error) {
      const reason = `${swapFailureReason(error)}: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(
        `generateClip: premium fell back to swap kind=${job.kind} reason=${reason}`,
      );
      premium = {
        status: "fallback",
        wanMs: Date.now() - renderStarted,
        reason: reason.slice(0, 300),
      };
      backend = "swap";
      plan = planClip({ session, job, speechMode, backend, parsedIntents });
    }
  }

  const greetingFromReference =
    backend === "swap" &&
    job.kind === "greeting" &&
    session.seedFrameUrl === session.anchorFrameUrl;
  const chainFromReference =
    backend === "swap" &&
    LIVE_TUNABLES.SWAP_CHAIN_FROM_REFERENCE &&
    !!session.identityFrameUrl &&
    job.kind !== "idle" &&
    job.kind !== "greeting";
  const videoBackend = renderBackendFor(backend, {
    greetingFromReference,
    chainFromReference,
  });
  // Only idle loops on the anchor; every other job chains forward from a real generated frame, single-image-seed style — pinning a hold's end frame to the seed never stopped it from drifting mid-clip, it only masked the seam for the next clip.
  // The greeting also loops when its seed is a staged in-scene still (seed differs from the identity photo), so the idles pre-stocked from that frame stay playable after it. On the raw upload it chains: the photo's clothes and room contradict the prompt and every loop back to it popped.
  const greetingLoops =
    job.kind === "greeting" && session.seedFrameUrl !== session.anchorFrameUrl;
  const isAnchoredLoop =
    !premiumClip &&
    (job.kind === "idle" || greetingLoops) &&
    videoBackend.supportsEndFrame;
  // Idle never seeds the next clip even where it cannot loop (reference backend); an anchored loop returns to its seed.
  const keepsSessionSeed = job.kind === "idle" || isAnchoredLoop;
  // Hold clip (idle/greeting/checkIn/non-wardrobe act/hold/pose transition) — must be verified before it can play; see checkFrame below.
  const isHoldClip = plan.wardrobeIntent === null && !plan.explicit;
  // Explicit act with no wardrobe change of its own (useProp, twerk, ...) — checked like a hold clip but fails open on an unchecked frame; see evaluateFrameChecks.
  const isExplicitNonWardrobe = plan.wardrobeIntent === null && plan.explicit;

  // Pose bank: a chain clip landing in a state seen before ends on that state's first clean frame and seeds from it, so the session seed stops accumulating one generation of drift per act.
  const bankedEndFrameUrl =
    backend === "swap" &&
    !LIVE_TUNABLES.VERIFY_FRAMES &&
    !keepsSessionSeed &&
    videoBackend.supportsEndFrame
      ? session.stateFrames?.[stateFrameKey(plan.expectedState)]
      : undefined;

  // A reference-rendered chain clip always carries the head-only crop: identity is the reason it left turbo, and the full upload's room and clothes were copied into the scene.
  const identityReferenceUrl = !videoBackend.supportsIdentityReference
    ? undefined
    : chainFromReference
      ? session.identityFrameUrl
      : useIdentityReference
        ? session.anchorFrameUrl
        : undefined;

  // The reference model has no first frame to inherit the room from, so the prompt establishes it and pins the upload to identity only.
  const prompt = greetingFromReference
    ? `Image 1 is the woman's identity only: face, hair, skin tone and build. Do not copy its pose, clothing or background. Scene: ${STAGE_ROOM_BY_SCENE[session.creator.sceneId]} ${plan.prompt}`
    : plan.prompt;
  const renderPromise = premiumClip
    ? Promise.resolve({
        videoUrl: premiumClip.videoUrl,
        costUsd: premiumClip.costUsd,
      })
    : videoBackend.render({
        prompt,
        seedFrameUrl: session.seedFrameUrl,
        durationSec: plan.durationSec,
        endFrameUrl: isAnchoredLoop ? session.seedFrameUrl : bankedEndFrameUrl,
        identityReferenceUrl,
      });

  // Render is the one hard-fail path — everything after this point degrades instead of throwing.
  const rendered = await renderPromise;
  const renderMs = Date.now() - renderStarted;
  console.log(
    `generateClip: renderMs=${renderMs} planMs=${planMs} kind=${job.kind} backend=${backend} dualRef=${videoBackend.supportsIdentityReference ? useIdentityReference : "n/a"} bankedEnd=${!!bankedEndFrameUrl}`,
  );
  // Clip-level trace: without the prompt and frame URLs a scene jump reported from a session could not be tied to a clip.
  console.log(
    `generateClip: trace kind=${job.kind} video=${rendered.videoUrl} seed=${session.seedFrameUrl} end=${isAnchoredLoop ? "loop" : (bankedEndFrameUrl ?? "none")} prompt=${JSON.stringify(prompt)}`,
  );

  // Swap backend: the swapped clip replaces turbo's output for playback and checks.
  let videoUrl = rendered.videoUrl;
  let costUsd = rendered.costUsd;
  let swapReport: ClipSwapReport | undefined;
  let swappedLastFrameUrl: string | null = null;
  if (premiumClip) {
    swapReport = premiumClip.report;
    swappedLastFrameUrl = premiumClip.lastFrameUrl;
  } else if (backend === "swap" && LIVE_TUNABLES.SWAP_DEFER_CLIP) {
    // Two-phase swap: the clip comes back unswapped and pending, so the chain renders its next clip right after this render instead of after the 7 s clip swap; the client swaps the full clip before it plays (api/live/swap). Seeding from a swapped tail was reverted in 820c0c6 for stacking a swap on an already swapped and restored face, but that was with GPEN restore at 0.8 plus colour lock at 0.5, and both are off now, so the seed below goes through /swapTail instead of staying on the raw render.
    swapReport = pendingSwapReport();
    onRendered?.(videoUrl);
  } else if (backend === "swap") {
    const swapStarted = Date.now();
    const recipe = swapRecipeFor(request.swapFaceLock);
    try {
      const swapped = await swapClip({
        videoUrl,
        personaId: request.personaId,
        budgetMs:
          job.kind === "greeting"
            ? swapGreetingBudgetMsFor(recipe, request.swapHandMask)
            : SWAP_BUDGET_MS,
        jobKind: job.kind,
        recipe,
        handMask: request.swapHandMask,
      });
      videoUrl = swapped.videoUrl;
      costUsd += swapped.costUsd;
      swapReport = swapped.report;
      swappedLastFrameUrl = swapped.lastFrameUrl;
    } catch (error) {
      // Quality feature, not a guard: the unswapped clip plays and the studio overlay shows the miss.
      if (job.kind === "greeting") {
        // The greeting gates the join, so a missed budget here is the join looking different from the rest of the session; recipe and reason pin down whether it's the longlive budget still too tight or a genuine service error.
        console.warn(
          `generateClip: greeting swap fell back to unswapped, reason=${swapFailureReason(error)} recipe=${recipe ?? "legacy"}`,
          error,
        );
      } else {
        console.warn(
          "generateClip: swap failed, playing the unswapped clip",
          error,
        );
      }
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
    if (bankedEndFrameUrl) {
      seedFrameUrl = bankedEndFrameUrl;
    } else if (!keepsSessionSeed) {
      const verifyStarted = Date.now();
      try {
        seedFrameUrl =
          swappedLastFrameUrl ??
          (await withTimeout(
            backend === "swap"
              ? // The swapped tail carries the persona's identity forward instead of the raw render's compounding drift; falls back to the raw /lastFrame path (then the fal extract) with no persona, a persona-gate refusal, or any other swapTail error.
                swapTail({
                  videoUrl,
                  personaId: request.personaId,
                  jobKind: job.kind,
                  recipe: swapRecipeFor(request.swapFaceLock),
                  toneReferenceUrl: session.toneFrameUrl,
                  handMask: request.swapHandMask,
                })
                  .then((swapped) => {
                    costUsd += swapped.costUsd;
                    return swapped.lastFrameUrl;
                  })
                  .catch((error: unknown) => {
                    console.warn(
                      "generateClip: swapTail failed, seeding from the raw last frame",
                      error,
                    );
                    return swapServiceLastFrame({
                      videoUrl,
                      toneReferenceUrl: session.toneFrameUrl,
                    }).catch((fallbackError: unknown) => {
                      console.warn(
                        "generateClip: swap service lastFrame failed, using fal extract",
                        fallbackError,
                      );
                      return extractLastFrameUrl(videoUrl, FRAME_BUDGET_MS);
                    });
                  })
              : extractLastFrameUrl(videoUrl, FRAME_BUDGET_MS),
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

  // The greeting draws its room from preset text while chain prompts carried the upload's own room, so every later clip drifted toward a room that was never on screen; ROOM is locked to what the greeting actually rendered.
  const roomPromise =
    greetingFromReference && seedFrameUrl !== session.seedFrameUrl
      ? withTimeout(
          captureRoom(seedFrameUrl),
          ROOM_CAPTURE_BUDGET_MS,
          "captureRoom",
        ).catch((error: unknown) => {
          // A timeout was silent before, which hid that prod's reads were all running out the budget.
          console.warn("generateClip: room capture skipped", error);
          return null;
        })
      : Promise.resolve(null);
  const [replyOutcome, capturedRoom] = await Promise.all([
    replyTextPromise,
    roomPromise,
  ]);
  const roomState = capturedRoom
    ? { ...expectedState, surroundings: capturedRoom }
    : expectedState;
  // A rejected clip's dialogue never rewrites canon: only an approved clip's nextWorld is adopted.
  const finalState =
    verdict === "approved" && replyOutcome?.nextWorld
      ? { ...roomState, world: replyOutcome.nextWorld.slice(0, 420) }
      : roomState;

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
    ...(plan.setupOnly ? { setupOnly: true } : {}),
    guard,
    observed: guardOutcome.observed,
    verdict,
    rejectReason,
    timings: { planMs, renderMs, frameMs, guardMs, repairMs: 0, verifyMs },
    costUsd,
    swap: swapReport,
    ...(premium ? { premium } : {}),
  };
};
