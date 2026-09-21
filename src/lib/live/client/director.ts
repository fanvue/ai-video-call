// Pure, framework-free session reducer; see docs/LIVE_ENGINE.md for the job-ordering rules.

import {
  LIVE_TUNABLES,
  type ClipJob,
  type ClipResult,
  type CreatorProfile,
  type GarmentId,
  type InputChannel,
  type LiveSessionSnapshot,
  type LiveState,
  type TranscriptEntry,
} from "@/lib/live/contract";

const GARMENT_IDS: readonly GarmentId[] = ["top", "bottom", "bra", "panties"];

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
  redressScheduledSinceLastRequest: boolean;
};

export type DirectorInit = {
  creator: CreatorProfile;
  anchorFrameUrl: string;
  anchorHasBody?: boolean;
  seedFrameUrl: string;
  liveState: LiveState;
  now: number;
};

const bodyEquals = (a: LiveState["body"], b: LiveState["body"]): boolean =>
  a.pose === b.pose &&
  a.facing === b.facing &&
  a.hands === b.hands &&
  a.contact === b.contact &&
  a.prop === b.prop &&
  a.framing === b.framing;

const garmentsOff = (liveState: LiveState): GarmentId[] =>
  GARMENT_IDS.filter((id) => !liveState.wardrobe[id].on);

// A new reply job goes behind any beats/settle still running the current request, ahead of
// idle-priority jobs (checkIn/redress) queued only because nothing else was happening.
const insertReplyIndex = (queue: ClipJob[]): number => {
  const settleIndex = queue.findIndex((job) => job.kind === "settle");
  if (settleIndex !== -1) {
    return settleIndex;
  }
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
      redressScheduledSinceLastRequest: false,
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
      redressScheduledSinceLastRequest: false,
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
      redressScheduledSinceLastRequest: false,
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

    const queue = [...this.state.jobQueue];
    for (const beat of result.followUps) {
      queue.push({ kind: "beat", beat });
    }

    const isInteractiveKind =
      result.jobKind === "reply" ||
      result.jobKind === "beat" ||
      result.jobKind === "checkIn";
    const hasMoreBeats = queue.some((job) => job.kind === "beat");
    const hasSettleQueued = queue.some((job) => job.kind === "settle");
    const isSequenceEnd = isInteractiveKind && !hasMoreBeats;
    if (
      isSequenceEnd &&
      !hasSettleQueued &&
      !bodyEquals(result.state.body, result.state.baselineBody)
    ) {
      queue.push({ kind: "settle" });
    }

    this.state = {
      ...this.state,
      liveState: result.state,
      seedFrameUrl: result.seedFrameUrl,
      transcript,
      jobQueue: queue,
    };
  }

  // Redress and checkIn are mutually exclusive idle stages: once idle has run long enough to
  // redress, that stage owns the tick and checkIn does not also fire alongside it.
  tick(now: number): void {
    if (this.state.jobQueue.length > 0) {
      return;
    }
    const idleMs = now - this.state.lastRequestAt;
    const queue: ClipJob[] = [];
    let checkedIn = this.state.checkedInSinceLastRequest;
    let redressScheduled = this.state.redressScheduledSinceLastRequest;

    if (idleMs >= LIVE_TUNABLES.REDRESS_AFTER_IDLE_MS) {
      if (!redressScheduled) {
        const off = garmentsOff(this.state.liveState);
        if (off.length > 0) {
          const reversed = [...this.state.liveState.wardrobe.removedOrder]
            .reverse()
            .filter((garment) => !this.state.liveState.wardrobe[garment].on);
          for (const garment of reversed) {
            queue.push({ kind: "redress", garment });
          }
        }
        redressScheduled = true;
      }
    } else if (idleMs >= LIVE_TUNABLES.CHECK_IN_AFTER_IDLE_MS && !checkedIn) {
      queue.push({ kind: "checkIn", channel: this.state.lastChannel });
      checkedIn = true;
    }

    if (queue.length === 0) {
      this.state = {
        ...this.state,
        checkedInSinceLastRequest: checkedIn,
        redressScheduledSinceLastRequest: redressScheduled,
      };
      return;
    }

    this.state = {
      ...this.state,
      jobQueue: queue,
      checkedInSinceLastRequest: checkedIn,
      redressScheduledSinceLastRequest: redressScheduled,
    };
  }

  // Idle jobs are never stored in the queue; synthesize one on demand when nothing is planned.
  nextJob(): ClipJob {
    const [job, ...rest] = this.state.jobQueue;
    if (!job) {
      return { kind: "idle" };
    }
    this.state = { ...this.state, jobQueue: rest };
    return job;
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
