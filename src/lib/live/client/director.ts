// Pure, framework-free session reducer; see docs/LIVE_ENGINE.md for the job-ordering rules.

import { isIntentSatisfied } from "@/lib/live/intents";
import {
  LIVE_TUNABLES,
  type ClipJob,
  type ClipResult,
  type CreatorProfile,
  type InputChannel,
  type LiveSessionSnapshot,
  type LiveState,
  type PlannedBeat,
  type TranscriptEntry,
} from "@/lib/live/contract";

export type DirectorState = {
  creator: CreatorProfile;
  liveState: LiveState;
  seedFrameUrl: string;
  anchorFrameUrl: string;
  anchorHasBody: boolean;
  startedAt: number;
  transcript: TranscriptEntry[];
  jobQueue: ClipJob[];
  lastRequestAt: number;
  lastChannel: InputChannel;
  // Each fires at most once per idle window; reset on the next fan request.
  checkedInSinceLastRequest: boolean;
  restScheduledSinceLastRequest: boolean;
  // The last job handed out by nextJob(), so clipCompleted can inspect a beat's own intent/attempt
  // without changing its signature (idle jobs are synthesized and never recorded here).
  lastDispatchedJob: ClipJob | null;
};

export type DirectorInit = {
  creator: CreatorProfile;
  anchorFrameUrl: string;
  anchorHasBody?: boolean;
  seedFrameUrl: string;
  liveState: LiveState;
  now: number;
};

// A new reply job goes behind any beats still running the current request, ahead of idle-priority
// jobs (checkIn) queued only because nothing else was happening.
const insertReplyIndex = (queue: ClipJob[]): number => {
  let lastBeatIndex = -1;
  for (let i = 0; i < queue.length; i += 1) {
    if (queue[i]?.kind === "beat") {
      lastBeatIndex = i;
    } else if (lastBeatIndex === -1) {
      break;
    }
  }
  return lastBeatIndex + 1;
};

export class LiveDirector {
  private state: DirectorState;
  private idCounter = 0;

  constructor(init: DirectorInit) {
    this.state = {
      creator: init.creator,
      liveState: init.liveState,
      seedFrameUrl: init.seedFrameUrl,
      anchorFrameUrl: init.anchorFrameUrl,
      anchorHasBody: init.anchorHasBody ?? true,
      startedAt: init.now,
      transcript: [],
      jobQueue: [{ kind: "greeting" }],
      lastRequestAt: init.now,
      lastChannel: "chat",
      checkedInSinceLastRequest: false,
      restScheduledSinceLastRequest: false,
      lastDispatchedJob: null,
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
      ...(payload.paid !== undefined ? { paid: payload.paid } : {}),
    };
    const queue = [...this.state.jobQueue];
    queue.splice(insertReplyIndex(queue), 0, job);
    this.state = {
      ...this.state,
      transcript: [...this.state.transcript, entry],
      jobQueue: queue,
      lastRequestAt: now,
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
      ...(paid ? { paid } : {}),
    };
    // Lower priority than the fan: always appended, never ahead of anything already queued. A
    // fanRequest arriving afterwards still jumps ahead of it via insertReplyIndex's own rule.
    const queue = [...this.state.jobQueue, job];
    this.state = {
      ...this.state,
      transcript: [...this.state.transcript, entry],
      jobQueue: queue,
      lastRequestAt: now,
      checkedInSinceLastRequest: false,
      restScheduledSinceLastRequest: false,
    };
    return { entry, job };
  }

  clipCompleted(result: ClipResult, now: number): void {
    // Idle/filler clips only cover a visual gap; they must never become canon, or clothing and
    // pose drift every time a filler renders instead of only on real interactive turns.
    if (result.jobKind === "idle") {
      return;
    }

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

    this.state = {
      ...this.state,
      liveState: result.state,
      seedFrameUrl: result.seedFrameUrl,
      transcript,
      jobQueue: queue,
    };
  }

  tick(now: number): void {
    if (this.state.jobQueue.length > 0) {
      return;
    }
    const idleMs = now - this.state.lastRequestAt;
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
      anchorHasBody: this.state.anchorHasBody,
      elapsedSec: this.elapsedSec(now),
      transcript,
    };
  }
}
