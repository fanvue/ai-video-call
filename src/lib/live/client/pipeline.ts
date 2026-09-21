// Anchored idle buffer + chained action queue (reply -> beats -> settle). See
// docs/LIVE_ENGINE.md "Clip chain: anchors and loops" / "Request latency policy".

import {
  LIVE_TUNABLES,
  type ClipJob,
  type ClipRequest,
  type ClipResult,
  type LiveSessionSnapshot,
  type LiveState,
  type RenderBackend,
  type SpeechMode,
} from "@/lib/live/contract";

export type PipelineEvent =
  | { type: "clipReady"; result: ClipResult; lane: "idle" | "chained" }
  | { type: "clipDiscarded"; result: ClipResult; costUsd: number }
  | { type: "bufferEmpty" }
  | { type: "bufferRecovered" }
  | { type: "anchorChanged"; frameUrl: string; state: LiveState; atMs: number }
  | { type: "error"; job: ClipJob; message: string }
  // Fires once a chain job leaves the queue and starts rendering (surfaces "she's getting to @handle's request").
  | { type: "chainJobStarted"; job: ClipJob };

export type ClipPipelineOptions = {
  render: (req: ClipRequest) => Promise<ClipResult>;
  now: () => number;
  onEvent: (event: PipelineEvent) => void;
  backend?: RenderBackend;
  speechMode?: SpeechMode;
};

export type SnapshotSource = () => LiveSessionSnapshot;

// Extra idle render per beat while a chain runs; flip off to save spend.
const BRIDGE_IDLES = true;

type AnchorPoint = { frameUrl: string; state: LiveState };

export type BufferStats = {
  idleReady: number;
  idleInflight: number;
  chainedReady: number;
};

export class ClipPipeline {
  private readonly render: ClipPipelineOptions["render"];
  private readonly now: () => number;
  private readonly onEvent: (event: PipelineEvent) => void;
  private backend: RenderBackend;
  private speechMode: SpeechMode;

  private getSnapshot: SnapshotSource | null = null;
  private getNextJob: (() => ClipJob) | null = null;
  private disposed = false;

  private anchor: AnchorPoint = {
    frameUrl: "",
    state: null as unknown as LiveState,
  };
  // Frame the currently displayed clip left the viewer on; only chained clips move it.
  private displayAnchorFrameUrl = "";

  private idleReady: ClipResult[] = [];
  private idleInflightCount = 0;
  // Non-looping idle clips drift their own end frame, so match for playback by the anchor they were rendered FROM.
  private idleAnchorByClipId = new Map<string, string>();

  private chainInflight: { job: ClipJob } | null = null;
  // Seed for the next chain job once the current one resolves; null = chain caught up with anchor.
  private chainTail: AnchorPoint | null = null;
  private chainedReady: ClipResult[] = [];

  private bufferIsEmpty = false;
  // Blocks idle from jumping ahead of the still-in-flight greeting, which shares its initial anchor.
  private firstChainClipPlayed = false;

  constructor(options: ClipPipelineOptions) {
    this.render = options.render;
    this.now = options.now;
    this.onEvent = options.onEvent;
    this.backend = options.backend ?? "turbo";
    this.speechMode = options.speechMode ?? "text";
  }

  setBackend(backend: RenderBackend): void {
    this.backend = backend;
  }

  setSpeechMode(speechMode: SpeechMode): void {
    this.speechMode = speechMode;
  }

  dispose(): void {
    this.disposed = true;
  }

  getBufferStats(): BufferStats {
    return {
      idleReady: this.idleReady.length,
      idleInflight: this.idleInflightCount,
      chainedReady: this.chainedReady.length,
    };
  }

  getReadyDurationsSec(): number {
    return [...this.idleReady, ...this.chainedReady].reduce(
      (sum, clip) => sum + clip.durationSec,
      0,
    );
  }

  // Kicks off the chain with the initial (greeting) job and wires the sources for later steps.
  start(
    initialJob: ClipJob,
    getSnapshot: SnapshotSource,
    getNextJob: () => ClipJob,
  ): void {
    this.getSnapshot = getSnapshot;
    this.getNextJob = getNextJob;
    const snapshot = getSnapshot();
    this.anchor = { frameUrl: snapshot.seedFrameUrl, state: snapshot.state };
    this.displayAnchorFrameUrl = snapshot.seedFrameUrl;
    this.submitChainJob(initialJob, 0);
    // Idle fillers render alongside the greeting on either backend, so one is ready the moment it ends.
    while (this.idleInflightCount < LIVE_TUNABLES.IDLE_MAX_INFLIGHT) {
      this.submitIdleJob(this.anchor, 0);
    }
  }

  // Try to run the just-queued job now; if the chain lane is busy it's picked up when it frees.
  onRequestEnqueued(): void {
    this.tryAdvanceChain();
  }

  // Call after director.tick() so timer-driven jobs (redress / checkIn) get picked up too.
  pollChain(): void {
    this.tryAdvanceChain();
  }

  // A requested clip is waiting; the player cuts into a looping idle for it rather than queueing behind it.
  hasChainedReady(): boolean {
    return this.chainedReady.length > 0;
  }

  // The player hands back a clip it pulled but will not play (an idle displaced by a cut-in).
  requeue(clip: ClipResult): void {
    if (clip.jobKind === "idle") {
      this.idleReady.unshift(clip);
      return;
    }
    this.chainedReady.unshift(clip);
  }

  // Playback boundary selection: eligibility is purely seed-frame match against the display anchor.
  nextClip(): ClipResult | null {
    const clip = this.pickNext();
    if (!clip) {
      if (!this.bufferIsEmpty) {
        this.bufferIsEmpty = true;
        this.onEvent({ type: "bufferEmpty" });
      }
      return null;
    }
    if (this.bufferIsEmpty) {
      this.bufferIsEmpty = false;
      this.onEvent({ type: "bufferRecovered" });
    }
    return clip;
  }

  private pickNext(): ClipResult | null {
    const chained = this.chainedReady[0];
    if (chained) {
      this.chainedReady.shift();
      this.displayAnchorFrameUrl = chained.seedFrameUrl;
      this.firstChainClipPlayed = true;
      this.fillIdleStockpile();
      return chained;
    }
    if (!this.firstChainClipPlayed) {
      return null;
    }
    const idleIndex = this.idleReady.findIndex(
      (clip) =>
        this.idleAnchorByClipId.get(clip.clipId) === this.displayAnchorFrameUrl,
    );
    if (idleIndex !== -1) {
      const [clip] = this.idleReady.splice(idleIndex, 1);
      this.fillIdleStockpile();
      return clip;
    }
    return null;
  }

  private hasPlayable(): boolean {
    return (
      this.chainedReady.length > 0 ||
      (this.firstChainClipPlayed &&
        this.idleReady.some(
          (clip) =>
            this.idleAnchorByClipId.get(clip.clipId) ===
            this.displayAnchorFrameUrl,
        ))
    );
  }

  private announceIfRecovered(): void {
    if (this.bufferIsEmpty && this.hasPlayable()) {
      this.bufferIsEmpty = false;
      this.onEvent({ type: "bufferRecovered" });
    }
  }

  // ---- Chain lane ----

  private chainActive(): boolean {
    return this.chainInflight !== null || this.chainTail !== null;
  }

  // Nothing is currently being served (used to gate viewer-request eligibility in roomSim).
  isChainIdle(): boolean {
    return !this.chainActive();
  }

  private tryAdvanceChain(): void {
    if (this.disposed || this.chainInflight) {
      return;
    }
    const getNextJob = this.getNextJob;
    if (!getNextJob) {
      return;
    }
    const job = getNextJob();
    if (job.kind === "idle") {
      // Nothing left to chain: if we were mid-sequence, its last result becomes the new anchor.
      this.promoteChainTailToAnchor();
      return;
    }
    this.submitChainJob(job, 0);
  }

  private promoteChainTailToAnchor(): void {
    if (!this.chainTail) {
      return;
    }
    const newAnchor = this.chainTail;
    this.chainTail = null;
    this.anchor = newAnchor;
    this.onEvent({
      type: "anchorChanged",
      frameUrl: newAnchor.frameUrl,
      state: newAnchor.state,
      atMs: this.now(),
    });
    this.fillIdleStockpile();
  }

  private submitChainJob(job: ClipJob, attempt: number): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.getSnapshot;
    if (!snapshot) {
      return;
    }
    const seed = this.chainTail ?? this.anchor;
    const request: ClipRequest = {
      session: {
        ...snapshot(),
        seedFrameUrl: seed.frameUrl,
        state: seed.state,
      },
      job,
      backend: this.backend,
      speechMode: this.speechMode,
    };
    this.chainInflight = { job };
    if (attempt === 0) {
      this.onEvent({ type: "chainJobStarted", job });
    }
    this.render(request).then(
      (result) => this.handleChainSettled(job, seed, attempt, result, null),
      (error: unknown) =>
        this.handleChainSettled(job, seed, attempt, null, error),
    );
  }

  private handleChainSettled(
    job: ClipJob,
    seed: AnchorPoint,
    attempt: number,
    result: ClipResult | null,
    error: unknown,
  ): void {
    if (this.disposed) {
      return;
    }
    this.chainInflight = null;

    if (error || !result) {
      if (attempt < 1) {
        this.chainInflight = { job };
        this.submitChainJob(job, attempt + 1);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.onEvent({ type: "error", job, message });
      // Abandon the rest of this chain (anchor stays put); drain any already-queued follow-on
      // jobs so a later poll doesn't run them from a seed that never rendered.
      this.drainDirectorQueue();
      this.fillIdleStockpile();
      return;
    }

    this.chainedReady.push(result);
    this.chainTail = { frameUrl: result.seedFrameUrl, state: result.state };
    // Bridge idles from the new tail can start rendering right away, alongside the next beat.
    this.fillIdleStockpile();
    this.onEvent({ type: "clipReady", result, lane: "chained" });
    this.announceIfRecovered();
    this.tryAdvanceChain();
  }

  private drainDirectorQueue(): void {
    const getNextJob = this.getNextJob;
    if (!getNextJob) {
      return;
    }
    // getNextJob() is a no-op once the queue reports idle, so this terminates.
    while (getNextJob().kind !== "idle") {
      // discard: queued against a chain step that failed and was abandoned
    }
  }

  // ---- Idle lane ----

  // While a chain runs, bridge idles seed from its tail instead of the (stale) display anchor.
  private idleLaneTarget(): AnchorPoint {
    return BRIDGE_IDLES ? (this.chainTail ?? this.anchor) : this.anchor;
  }

  // Only stock seeded from the idle lane target counts toward the buffer target; others stay
  // playable until consumed (an old-anchor idle) or promoted (a bridge idle once its tail lands).
  private idleLaneTargetReadyCount(): number {
    const target = this.idleLaneTarget();
    return this.idleReady.filter(
      (clip) => this.idleAnchorByClipId.get(clip.clipId) === target.frameUrl,
    ).length;
  }

  // Runs even while the chain lane is busy: idle filler is what covers a chain render's latency.
  private fillIdleStockpile(): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.getSnapshot;
    if (!snapshot) {
      return;
    }
    while (
      this.idleLaneTargetReadyCount() + this.idleInflightCount <
        LIVE_TUNABLES.IDLE_BUFFER_TARGET &&
      this.idleInflightCount < LIVE_TUNABLES.IDLE_MAX_INFLIGHT
    ) {
      this.submitIdleJob(this.idleLaneTarget(), 0);
    }
  }

  private submitIdleJob(anchorAtSubmit: AnchorPoint, attempt: number): void {
    const snapshot = this.getSnapshot;
    if (!snapshot || this.disposed) {
      return;
    }
    const request: ClipRequest = {
      session: {
        ...snapshot(),
        seedFrameUrl: anchorAtSubmit.frameUrl,
        state: anchorAtSubmit.state,
      },
      job: { kind: "idle" },
      // Idle is never committed as canon or reused as a seed, so always use the faster turbo backend.
      backend: "turbo",
      speechMode: this.speechMode,
    };
    this.idleInflightCount += 1;
    this.render(request).then(
      (result) => this.handleIdleSettled(anchorAtSubmit, attempt, result, null),
      (error: unknown) =>
        this.handleIdleSettled(anchorAtSubmit, attempt, null, error),
    );
  }

  private handleIdleSettled(
    anchorAtSubmit: AnchorPoint,
    attempt: number,
    result: ClipResult | null,
    error: unknown,
  ): void {
    this.idleInflightCount -= 1;
    if (this.disposed) {
      return;
    }

    if (error || !result) {
      if (attempt < 1) {
        this.idleInflightCount += 1;
        this.submitIdleJob(anchorAtSubmit, attempt + 1);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.onEvent({ type: "error", job: { kind: "idle" }, message });
      this.fillIdleStockpile();
      return;
    }

    const stillCurrent =
      anchorAtSubmit.frameUrl === this.anchor.frameUrl ||
      anchorAtSubmit.frameUrl === this.chainTail?.frameUrl;
    if (!stillCurrent) {
      // Neither the anchor nor a bridge idle's chain tail matches anymore; log the cost and drop it.
      this.onEvent({
        type: "clipDiscarded",
        result,
        costUsd: result.costUsd,
      });
      this.fillIdleStockpile();
      return;
    }

    // Non-looping (reference backend) filler is one-shot and never becomes canon (director.clipCompleted
    // drops idle results), so it's safe to play even though its own end frame has drifted.
    this.idleAnchorByClipId.set(result.clipId, anchorAtSubmit.frameUrl);
    this.idleReady.push(result);
    this.onEvent({ type: "clipReady", result, lane: "idle" });
    this.announceIfRecovered();
    this.fillIdleStockpile();
  }
}
