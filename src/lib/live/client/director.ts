// Pure, framework-free session reducer; see docs/LIVE_ENGINE.md for the job-ordering rules.

import { isIntentSatisfied } from "@/lib/live/intents";
import {
  LIVE_TUNABLES,
  stateFrameKey,
  type ClipJob,
  type ClipResult,
  type CreatorProfile,
  type InputChannel,
  type LiveSessionSnapshot,
  type LiveState,
  type PlannedBeat,
  type TranscriptEntry,
} from "@/lib/live/contract";

// Per-request lifecycle the UI can render (queue strip chip, transcript failure line). Driven by
// pipeline events; see useLiveSession's handlePipelineEvent for the generating/playing transitions.
export type RequestStatus =
  "queued" | "generating" | "playing" | "done" | "failed";

export type DirectorState = {
  creator: CreatorProfile;
  liveState: LiveState;
  seedFrameUrl: string;
  anchorFrameUrl: string;
  startedAt: number;
  transcript: TranscriptEntry[];
  jobQueue: ClipJob[];
  // Keyed by fan/viewer request (transcript entry) id. Never cleared, so a late UI read still
  // finds the terminal status; the hook is responsible for how long a "failed" chip stays visible.
  requestStatuses: Record<string, RequestStatus>;
  // Last time genuine (non-idle) activity happened: a fan/viewer request arriving, or a non-idle
  // clip completing. Idle-threshold ticks (rest / checkIn) measure from this, not wall-clock alone.
  lastActivityAt: number;
  lastChannel: InputChannel;
  // Each fires at most once per idle window; reset on the next fan request.
  checkedInSinceLastRequest: boolean;
  restScheduledSinceLastRequest: boolean;
  // The last job handed out by nextJob(), so clipCompleted can inspect a beat's own intent/attempt
  // without changing its signature (idle jobs are synthesized and never recorded here).
  lastDispatchedJob: ClipJob | null;
  // Last time a chain render was told to include the dual identity reference; ticks past
  // IDENTITY_REFERENCE_INTERVAL_MS. See consumeIdentityReferenceDue.
  lastIdentityReferenceAtMs: number;
  // Chain clips committed since the last identity reference; ticks past
  // IDENTITY_REFERENCE_MAX_CHAIN_CLIPS. See consumeIdentityReferenceDue.
  chainClipsSinceIdentityReference: number;
  // The greeting's tail, the session's first rendered frame; later seeds are tone-locked to it.
  toneFrameUrl?: string;
  stateFrames: Record<string, string>;
};

export type DirectorInit = {
  creator: CreatorProfile;
  anchorFrameUrl: string;
  seedFrameUrl: string;
  liveState: LiveState;
  now: number;
};

// A new fan reply goes behind every queued beat/fan-reply (FIFO for fan requests), ahead of a
// queued viewer reply, and ahead of background work (checkIn).
const insertReplyIndex = (queue: ClipJob[]): number => {
  let index = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const job = queue[i];
    if (job?.kind === "beat" || (job?.kind === "reply" && job.from === "fan")) {
      index = i + 1;
    } else if (job?.kind === "checkIn") {
      break;
    }
  }
  return index;
};

export class LiveDirector {
  private state: DirectorState;
  private idCounter = 0;
  // Session-scoped, never cleared: guards clipCompleted against re-applying the same clip twice.
  private committedClipIds = new Set<string>();

  constructor(init: DirectorInit) {
    this.state = {
      creator: init.creator,
      liveState: init.liveState,
      seedFrameUrl: init.seedFrameUrl,
      anchorFrameUrl: init.anchorFrameUrl,
      stateFrames: {},
      startedAt: init.now,
      transcript: [],
      jobQueue: [{ kind: "greeting" }],
      requestStatuses: {},
      lastActivityAt: init.now,
      lastChannel: "chat",
      checkedInSinceLastRequest: false,
      restScheduledSinceLastRequest: false,
      lastDispatchedJob: null,
      lastIdentityReferenceAtMs: init.now,
      chainClipsSinceIdentityReference: 0,
    };
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  private elapsedSec(now: number): number {
    return Math.max(0, Math.floor((now - this.state.startedAt) / 1000));
  }

  getState(): DirectorState {
    return this.state;
  }

  fanRequest(
    payload: { text: string; channel: InputChannel; paid?: boolean },
    now: number,
  ): { entry: TranscriptEntry; job: ClipJob } {
    const precededByIdle =
      now - this.state.lastActivityAt >=
      LIVE_TUNABLES.TYPING_LEAD_AFTER_IDLE_MS;
    const entry: TranscriptEntry = {
      id: this.nextId("fan"),
      role: "fan",
      channel: payload.channel,
      text: payload.text,
      atSec: this.elapsedSec(now),
      ...(payload.paid !== undefined ? { paid: payload.paid } : {}),
    };
    const job: ClipJob = {
      kind: "reply",
      requestId: entry.id,
      text: payload.text,
      channel: payload.channel,
      from: "fan",
      precededByIdle,
      ...(payload.paid !== undefined ? { paid: payload.paid } : {}),
    };
    const queue = [...this.state.jobQueue];
    queue.splice(insertReplyIndex(queue), 0, job);
    this.state = {
      ...this.state,
      transcript: [...this.state.transcript, entry],
      jobQueue: queue,
      requestStatuses: { ...this.state.requestStatuses, [entry.id]: "queued" },
      lastActivityAt: now,
      lastChannel: payload.channel,
      checkedInSinceLastRequest: false,
      restScheduledSinceLastRequest: false,
    };
    return { entry, job };
  }

  // A later fanRequest naturally jumps ahead of this while it's still queued (pre-emption rule).
  viewerRequest(
    payload: { handle: string; text: string; tipCents?: number },
    now: number,
  ): { entry: TranscriptEntry; job: ClipJob } {
    const paid = payload.tipCents !== undefined;
    const precededByIdle =
      now - this.state.lastActivityAt >=
      LIVE_TUNABLES.TYPING_LEAD_AFTER_IDLE_MS;
    const entry: TranscriptEntry = {
      id: this.nextId("viewer"),
      role: "viewer",
      handle: payload.handle,
      channel: "chat",
      text: payload.text,
      atSec: this.elapsedSec(now),
      ...(paid ? { paid, tipCents: payload.tipCents } : {}),
    };
    const job: ClipJob = {
      kind: "reply",
      requestId: entry.id,
      text: payload.text,
      channel: "chat",
      from: "viewer",
      handle: payload.handle,
      precededByIdle,
      ...(paid ? { paid } : {}),
    };
    // Lower priority than the fan: always appended, never ahead of anything already queued. A
    // fanRequest arriving afterwards still jumps ahead of it via insertReplyIndex's own rule.
    const queue = [...this.state.jobQueue, job];
    this.state = {
      ...this.state,
      transcript: [...this.state.transcript, entry],
      jobQueue: queue,
      requestStatuses: { ...this.state.requestStatuses, [entry.id]: "queued" },
      lastActivityAt: now,
      checkedInSinceLastRequest: false,
      restScheduledSinceLastRequest: false,
    };
    return { entry, job };
  }

  // UI-driven transition (job dispatched -> "generating", clip on screen -> "playing", a failed
  // clip -> "failed"); "queued" and "done" are set internally. No-op for an unknown requestId.
  setRequestStatus(requestId: string, status: RequestStatus): void {
    this.state = {
      ...this.state,
      requestStatuses: { ...this.state.requestStatuses, [requestId]: status },
    };
  }

  clipCompleted(result: ClipResult, now: number): void {
    // Idle/filler clips only cover a visual gap; they must never become canon, or clothing and
    // pose drift every time a filler renders instead of only on real interactive turns.
    if (result.jobKind === "idle") {
      return;
    }
    // Already committed this exact clip once; a repeat delivery must not double-apply it.
    if (this.committedClipIds.has(result.clipId)) {
      return;
    }
    this.state = { ...this.state, lastActivityAt: now };
    if (result.jobKind === "greeting" && !this.state.toneFrameUrl) {
      this.state = { ...this.state, toneFrameUrl: result.seedFrameUrl };
    }
    // The pipeline never plays a rejected clip; refuse its state too so a guard failure can't
    // rewrite canon through a caller that forgot to check the verdict.
    if (result.verdict === "rejected") {
      return;
    }
    this.committedClipIds.add(result.clipId);

    let transcript = this.state.transcript;
    if (result.reply) {
      transcript = [
        ...transcript,
        {
          id: this.nextId("creator"),
          role: "creator",
          channel: result.reply.channel,
          text: result.reply.text,
          atSec: this.elapsedSec(now),
        },
      ];
    }

    // A request that arrived mid-render must stay BEHIND this clip's own follow-ups, so unshift
    // them onto the front of the queue rather than appending.
    let queue = [...this.state.jobQueue];
    if (result.followUps.length > 0) {
      const followUpJobs: ClipJob[] = result.followUps.map((beat) => ({
        kind: "beat",
        beat,
      }));
      queue = [...followUpJobs, ...queue];
    }

    // Bounded retry: a wardrobe beat whose target the guard shows unmet gets exactly one re-attempt.
    const dispatchedJob = this.state.lastDispatchedJob;
    if (
      result.jobKind === "beat" &&
      dispatchedJob?.kind === "beat" &&
      (dispatchedJob.beat.intent.type === "removeGarment" ||
        dispatchedJob.beat.intent.type === "addGarment") &&
      dispatchedJob.beat.attempt === 0 &&
      !isIntentSatisfied(dispatchedJob.beat.intent, result.state)
    ) {
      const retryBeat: PlannedBeat = { ...dispatchedJob.beat, attempt: 1 };
      queue = [{ kind: "beat", beat: retryBeat }, ...queue];
    }

    // A request is "done" once its last clip finishes and nothing of its own remains queued
    // (a reply's own follow-ups, or a beat's own retry, both already folded into `queue` above).
    const requestId =
      dispatchedJob?.kind === "reply"
        ? dispatchedJob.requestId
        : dispatchedJob?.kind === "beat"
          ? (dispatchedJob.beat.requestId ?? null)
          : null;
    let requestStatuses = this.state.requestStatuses;
    if (
      requestId &&
      !queue.some(
        (job) =>
          job.kind === "beat" && (job.beat.requestId ?? null) === requestId,
      )
    ) {
      requestStatuses = { ...requestStatuses, [requestId]: "done" };
    }

    const stateKey = stateFrameKey(result.state);
    const stateFrames =
      stateKey in this.state.stateFrames ||
      Object.keys(this.state.stateFrames).length >=
        LIVE_TUNABLES.STATE_FRAMES_MAX
        ? this.state.stateFrames
        : { ...this.state.stateFrames, [stateKey]: result.seedFrameUrl };

    this.state = {
      ...this.state,
      liveState: result.state,
      seedFrameUrl: result.seedFrameUrl,
      stateFrames,
      transcript,
      jobQueue: queue,
      requestStatuses,
      // Counts every committed chain clip (idle/rejected/repeat deliveries never reach here);
      // reset alongside lastIdentityReferenceAtMs whenever consumeIdentityReferenceDue fires.
      chainClipsSinceIdentityReference:
        this.state.chainClipsSinceIdentityReference + 1,
    };
  }

  // The bank entry a chain clip banked is its raw tail; once its full swap lands, the swapped last frame is the identity-correct keyframe for re-entering that state. Only the bank changes: the live seed and anchors stay put.
  swappedLastFrameLanded(result: ClipResult): void {
    if (
      result.jobKind === "idle" ||
      result.jobKind === "greeting" ||
      result.swap?.status !== "swapped" ||
      !result.swappedLastFrameUrl
    ) {
      return;
    }
    const stateKey = stateFrameKey(result.state);
    if (this.state.stateFrames[stateKey] !== result.seedFrameUrl) {
      return;
    }
    this.state = {
      ...this.state,
      stateFrames: {
        ...this.state.stateFrames,
        [stateKey]: result.swappedLastFrameUrl,
      },
    };
  }

  // Drops queued beats owned by an abandoned request; `null` targets only ownerless beats.
  abandonRequest(requestId: string | null): void {
    const jobQueue = this.state.jobQueue.filter((job) => {
      if (job.kind !== "beat") {
        return true;
      }
      return (job.beat.requestId ?? null) !== requestId;
    });
    const requestStatuses = requestId
      ? {
          ...this.state.requestStatuses,
          [requestId]: "failed" as RequestStatus,
        }
      : this.state.requestStatuses;
    this.state = { ...this.state, jobQueue, requestStatuses };
  }

  // `activity.busy` covers work the queue can't see: a job already dispatched and rendering, or
  // its clip currently playing. Background jobs must not schedule while either is true.
  tick(now: number, activity: { busy: boolean }): void {
    if (this.state.jobQueue.length > 0 || activity.busy) {
      return;
    }
    const idleMs = now - this.state.lastActivityAt;
    const queue: ClipJob[] = [];
    let checkedIn = this.state.checkedInSinceLastRequest;
    let restScheduled = this.state.restScheduledSinceLastRequest;

    // Rest and check-in fire off independent idle thresholds, not an if/else chain, so a
    // 90s-idle tick still schedules the check-in even though the 20s rest threshold also elapsed.
    if (idleMs >= LIVE_TUNABLES.REST_AFTER_IDLE_MS) {
      if (
        !restScheduled &&
        !isIntentSatisfied({ type: "rest" }, this.state.liveState)
      ) {
        queue.push({
          kind: "beat",
          beat: {
            id: this.nextId("rest"),
            intent: { type: "rest" },
            attempt: 0,
          },
        });
      }
      restScheduled = true;
    }
    if (idleMs >= LIVE_TUNABLES.CHECK_IN_AFTER_IDLE_MS && !checkedIn) {
      queue.push({ kind: "checkIn", channel: this.state.lastChannel });
      checkedIn = true;
    }

    this.state = {
      ...this.state,
      jobQueue: queue,
      checkedInSinceLastRequest: checkedIn,
      restScheduledSinceLastRequest: restScheduled,
    };
  }

  // Gated periodically, not every chain render — dual-reference was adding its fal latency to every requested clip.
  // Fires on whichever trigger (interval elapsed or chain clip count) comes first, so a rapid burst can't drift for the full interval.
  consumeIdentityReferenceDue(now: number): boolean {
    const intervalElapsed =
      now - this.state.lastIdentityReferenceAtMs >=
      LIVE_TUNABLES.IDENTITY_REFERENCE_INTERVAL_MS;
    const chainLimitReached =
      this.state.chainClipsSinceIdentityReference >=
      LIVE_TUNABLES.IDENTITY_REFERENCE_MAX_CHAIN_CLIPS;
    if (!intervalElapsed && !chainLimitReached) {
      return false;
    }
    this.state = {
      ...this.state,
      lastIdentityReferenceAtMs: now,
      chainClipsSinceIdentityReference: 0,
    };
    return true;
  }

  // Idle jobs are never stored in the queue; synthesize one on demand when nothing is planned. A
  // beat whose intent is already satisfied by current state is a no-op and is dropped, not run.
  nextJob(): ClipJob {
    let queue = this.state.jobQueue;
    while (queue.length > 0) {
      const [job, ...rest] = queue;
      if (!job) {
        break;
      }
      if (
        job.kind === "beat" &&
        isIntentSatisfied(job.beat.intent, this.state.liveState)
      ) {
        queue = rest;
        continue;
      }
      this.state = { ...this.state, jobQueue: rest, lastDispatchedJob: job };
      return job;
    }
    this.state = { ...this.state, jobQueue: queue };
    return { kind: "idle" };
  }

  snapshot(now: number): LiveSessionSnapshot {
    const transcript = this.state.transcript.slice(
      -LIVE_TUNABLES.TRANSCRIPT_WINDOW,
    );
    return {
      creator: this.state.creator,
      state: this.state.liveState,
      seedFrameUrl: this.state.seedFrameUrl,
      anchorFrameUrl: this.state.anchorFrameUrl,
      toneFrameUrl: this.state.toneFrameUrl,
      stateFrames: this.state.stateFrames,
      elapsedSec: this.elapsedSec(now),
      transcript,
    };
  }
}
