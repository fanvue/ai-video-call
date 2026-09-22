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
  | { type: "chainJobStarted"; job: ClipJob }
  // Fires once when cumulative spend reaches SESSION_COST_CAP_USD; no further jobs are dispatched.
  | { type: "costCapReached"; totalCostUsd: number };

export type ClipPipelineOptions = {
  render: (req: ClipRequest) => Promise<ClipResult>;
  now: () => number;
  onEvent: (event: PipelineEvent) => void;
  backend?: RenderBackend;
  speechMode?: SpeechMode;
  // Called with a chain job that failed past retry, so the caller (director) can drop only that
  // request's own queued follow-ups instead of the whole queue.
  abandonDependents?: (job: ClipJob) => void;
  // Called after a chain clip already resolved (never gates clipReady/playback) to sharpen the
  // seed it left behind before the NEXT chain job renders from it. See upscaleChainTailInBackground.
  upscaleSeed?: (
    frameUrl: string,
  ) => Promise<{ url: string | null; costUsd: number }>;
  // Whether the next chain job should include the dual identity reference (see consumeIdentityReferenceDue).
  needsIdentityReference?: () => boolean;
};

export type SnapshotSource = () => LiveSessionSnapshot;

// Extra idle render per beat while a chain runs; flip off to save spend.
const BRIDGE_IDLES = true;

type AnchorPoint = { frameUrl: string; state: LiveState };

// Which trusted seed a settled state may re-seed from: same garments, prop, pose and framing.
const lookKey = (state: LiveState): string =>
  [
    state.wardrobe.top.on,
    state.wardrobe.bottom.on,
    state.wardrobe.bra.on,
    state.wardrobe.panties.on,
    state.body.prop,
    state.body.pose,
    state.body.framing,
  ].join("|");

export type BufferStats = {
  idleReady: number;
  idleInflight: number;
  chainedReady: number;
};

export class ClipPipeline {
  private readonly render: ClipPipelineOptions["render"];
  private readonly now: () => number;
  private readonly onEvent: (event: PipelineEvent) => void;
  private readonly abandonDependents?: (job: ClipJob) => void;
  private readonly upscaleSeed?: ClipPipelineOptions["upscaleSeed"];
  private readonly needsIdentityReference?: () => boolean;
  private backend: RenderBackend;
  private speechMode: SpeechMode;

  private getSnapshot: SnapshotSource | null = null;
  private getNextJob: (() => ClipJob) | null = null;
  private disposed = false;

  private anchor: AnchorPoint = {
    frameUrl: "",
    state: null as unknown as LiveState,
  };
  // Frame the currently PLAYING clip left the viewer on; UI only, set by onClipStarted.
  private displayAnchorFrameUrl = "";
  // Frame the last clip handed to the player ends on; selection chains from this, since the player preloads the next clip while the current one is still on screen.
  private playoutCursorFrameUrl = "";

  private idleReady: ClipResult[] = [];
  private idleInflightCount = 0;
  // In-flight idles per seed frame, so old-anchor idles still rendering do not block a bridge idle for a new chain tail.
  private idleInflightBySeed = new Map<string, number>();
  // Non-looping idle clips drift their own end frame, so match for playback by the anchor they were rendered FROM.
  private idleAnchorByClipId = new Map<string, string>();

  private chainInflight: { job: ClipJob } | null = null;
  // Seed for the next chain job once the current one resolves; null = chain caught up with anchor.
  private chainTail: AnchorPoint | null = null;
  private chainedReady: ClipResult[] = [];
  // First settled frame per look (the upload for the initial one); a finished plan re-seeds from it, so generated descendants never stack deeper than one plan.
  private trustedSeedByLook = new Map<string, string>();
  // Drifted tail frame -> the trusted frame it was re-seeded to; idles rendered from the trusted frame must stay playable after the tail's own clip.
  private seedAlias = new Map<string, string>();

  private bufferIsEmpty = false;
  // Blocks idle from jumping ahead of the still-in-flight greeting, which shares its initial anchor.
  private firstChainClipPlayed = false;

  // Cumulative render spend, tallied from every clipReady/clipDiscarded result's own costUsd.
  private totalCostUsd = 0;
  private costCapReached = false;
  private lastUpscaleAtMs = -Infinity;
  private lastSceneResetAtMs = -Infinity;
  // Wall time of the last few idle productions (render + swap + rehost), so the next idle can be made at least that long.
  private idleProductionMs: number[] = [];

  constructor(options: ClipPipelineOptions) {
    this.render = options.render;
    this.now = options.now;
    this.onEvent = options.onEvent;
    this.abandonDependents = options.abandonDependents;
    this.upscaleSeed = options.upscaleSeed;
    this.needsIdentityReference = options.needsIdentityReference;
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

  // Tallies a clip's cost (approved or discarded, both already carry costUsd) and emits
  // costCapReached exactly once when the cumulative total reaches the cap.
  private addCost(costUsd: number): void {
    this.totalCostUsd += costUsd;
    if (
      !this.costCapReached &&
      this.totalCostUsd >= LIVE_TUNABLES.SESSION_COST_CAP_USD
    ) {
      this.costCapReached = true;
      this.onEvent({ type: "costCapReached", totalCostUsd: this.totalCostUsd });
    }
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
    this.trustedSeedByLook.set(lookKey(snapshot.state), snapshot.seedFrameUrl);
    this.lastSceneResetAtMs = this.now();
    this.displayAnchorFrameUrl = snapshot.seedFrameUrl;
    this.playoutCursorFrameUrl = snapshot.seedFrameUrl;
    this.submitChainJob(initialJob, 0);
    // Idle fillers render alongside the greeting on either backend, so one is ready the moment it ends.
    this.fillIdleStockpile();
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

  private sameSeed(a: string, b: string): boolean {
    return (this.seedAlias.get(a) ?? a) === (this.seedAlias.get(b) ?? b);
  }

  private pickNext(): ClipResult | null {
    const chained = this.chainedReady[0];
    if (chained) {
      this.chainedReady.shift();
      this.firstChainClipPlayed = true;
      this.playoutCursorFrameUrl = chained.seedFrameUrl;
      this.fillIdleStockpile();
      return chained;
    }
    if (!this.firstChainClipPlayed) {
      return null;
    }
    // Idles loop back to their anchor, so handing one out leaves the cursor where it was.
    // An idle rendered from the exact cursor frame is seamless; one from its trusted alias is a small cut, so it is the fallback.
    const exactIndex = this.idleReady.findIndex(
      (clip) =>
        this.idleAnchorByClipId.get(clip.clipId) === this.playoutCursorFrameUrl,
    );
    const idleIndex =
      exactIndex !== -1
        ? exactIndex
        : this.idleReady.findIndex((clip) =>
            this.sameSeed(
              this.idleAnchorByClipId.get(clip.clipId) ?? "",
              this.playoutCursorFrameUrl,
            ),
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
        this.idleReady.some((clip) =>
          this.sameSeed(
            this.idleAnchorByClipId.get(clip.clipId) ?? "",
            this.playoutCursorFrameUrl,
          ),
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

  // A chain job is in flight, or a tail is holding clips not yet played/promoted; used to keep
  // background timers (rest/checkIn) from firing mid-request.
  isChainActive(): boolean {
    return this.chainActive();
  }

  // The frame the current chain step is (or would be) seeded from; used to assert the anchor
  // didn't move when a chain job fails and is abandoned.
  getCurrentAnchorFrameUrl(): string {
    return (this.chainTail ?? this.anchor).frameUrl;
  }

  // Called once the player confirms a pulled clip is actually on screen; a clip merely pulled to
  // preload must never move this (that was the bug: preloading silently advanced the anchor).
  onClipStarted(seedFrameUrl: string): void {
    this.displayAnchorFrameUrl = seedFrameUrl;
  }

  private tryAdvanceChain(): void {
    if (this.disposed || this.chainInflight || this.costCapReached) {
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
    const tail = this.chainTail;
    this.chainTail = null;
    const key = lookKey(tail.state);
    const trusted = this.trustedSeedByLook.get(key);
    let newAnchor = tail;
    if (!trusted) {
      this.trustedSeedByLook.set(key, tail.frameUrl);
    } else if (this.backend !== "reference" && !this.sceneResetDue()) {
      // Turbo has no identity reference pulling the tail back toward the photo, so a re-seed there is a hard jump to the upload; continuity wins over drift.
    } else if (trusted !== tail.frameUrl) {
      this.seedAlias.set(tail.frameUrl, trusted);
      newAnchor = { ...tail, frameUrl: trusted };
      this.lastSceneResetAtMs = this.now();
    }
    this.anchor = newAnchor;
    this.onEvent({
      type: "anchorChanged",
      frameUrl: newAnchor.frameUrl,
      state: newAnchor.state,
      atMs: this.now(),
    });
    this.fillIdleStockpile();
  }

  // Swap locks the face every clip, so a periodic cut back to the trusted frame only resets the drifted scene around it.
  private sceneResetDue(): boolean {
    return (
      this.backend === "swap" &&
      this.now() - this.lastSceneResetAtMs >=
        LIVE_TUNABLES.SWAP_SCENE_RESET_INTERVAL_MS
    );
  }

  private idleBufferTarget(): number {
    return this.backend === "swap"
      ? LIVE_TUNABLES.SWAP_IDLE_BUFFER_TARGET
      : LIVE_TUNABLES.IDLE_BUFFER_TARGET;
  }

  private idleMaxInflight(): number {
    return this.backend === "swap"
      ? LIVE_TUNABLES.SWAP_IDLE_MAX_INFLIGHT
      : LIVE_TUNABLES.IDLE_MAX_INFLIGHT;
  }

  // Long enough that the next filler is ready before this one ends, judged from how long the last few took to make.
  private nextIdleDurationSec(): number {
    if (this.idleProductionMs.length === 0) {
      return LIVE_TUNABLES.IDLE_CLIP_SEC;
    }
    const slowestMs = Math.max(...this.idleProductionMs);
    return Math.min(
      LIVE_TUNABLES.MAX_CLIP_SEC,
      Math.max(
        LIVE_TUNABLES.IDLE_CLIP_SEC,
        Math.ceil(slowestMs / 1000) + LIVE_TUNABLES.IDLE_HEADROOM_SEC,
      ),
    );
  }

  private recordIdleProduction(startedAtMs: number): void {
    this.idleProductionMs.push(this.now() - startedAtMs);
    if (this.idleProductionMs.length > 3) {
      this.idleProductionMs.shift();
    }
  }

  private submitChainJob(job: ClipJob, attempt: number): void {
    if (this.disposed || this.costCapReached) {
      return;
    }
    const snapshot = this.getSnapshot;
    if (!snapshot) {
      return;
    }
    const seed = this.chainTail ?? this.anchor;
    // Only checked on the first attempt: a retry of the same job must not re-consume the gate.
    const useIdentityReference =
      attempt === 0 && (this.needsIdentityReference?.() ?? false);
    const request: ClipRequest = {
      session: {
        ...snapshot(),
        seedFrameUrl: seed.frameUrl,
        state: seed.state,
      },
      job,
      backend: this.backend,
      speechMode: this.speechMode,
      useIdentityReference,
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

    // A guard-rejected clip already cost money but must never reach the screen or become canon.
    const rejected = result !== null && result.verdict === "rejected";
    if (rejected) {
      this.onEvent({ type: "clipDiscarded", result, costUsd: result.costUsd });
      this.addCost(result.costUsd);
    }
    if (error || !result || rejected) {
      if (attempt < LIVE_TUNABLES.CHAIN_MAX_ATTEMPTS - 1) {
        this.chainInflight = { job };
        this.submitChainJob(job, attempt + 1);
        return;
      }
      const message = rejected
        ? (result.rejectReason ?? "clip rejected by frame guard")
        : error instanceof Error
          ? error.message
          : String(error);
      this.onEvent({ type: "error", job, message });
      // The failed clip never resolved, so it never touched chainTail/anchor: both are still
      // exactly where the last successful step (if any) left them.
      this.abandonDependents?.(job);
      this.fillIdleStockpile();
      // An unrelated request queued behind the failed one starts now, not on the next tick.
      this.tryAdvanceChain();
      return;
    }

    this.chainedReady.push(result);
    this.chainTail = { frameUrl: result.seedFrameUrl, state: result.state };
    // Bridge idles from the new tail can start rendering right away, alongside the next beat.
    this.fillIdleStockpile();
    this.onEvent({ type: "clipReady", result, lane: "chained" });
    this.addCost(result.costUsd);
    this.announceIfRecovered();
    this.tryAdvanceChain();
    const upscaleIntervalMs =
      this.backend === "swap"
        ? LIVE_TUNABLES.SWAP_UPSCALE_INTERVAL_MS
        : LIVE_TUNABLES.UPSCALE_INTERVAL_MS;
    if (this.now() - this.lastUpscaleAtMs >= upscaleIntervalMs) {
      this.lastUpscaleAtMs = this.now();
      this.upscaleChainTailInBackground(result.seedFrameUrl);
    }
  }

  // Patches whichever of chainTail/anchor still holds the raw frame; tryAdvanceChain may have
  // already promoted chainTail into anchor by the time this resolves. Neither matching = stale, drop it.
  private upscaleChainTailInBackground(rawFrameUrl: string): void {
    if (!this.upscaleSeed) return;
    this.upscaleSeed(rawFrameUrl)
      .then(({ url, costUsd }) => {
        if (this.disposed) return;
        if (costUsd > 0) this.addCost(costUsd);
        if (!url) return;
        if (this.chainTail?.frameUrl === rawFrameUrl) {
          this.chainTail = { ...this.chainTail, frameUrl: url };
        } else if (this.anchor.frameUrl === rawFrameUrl) {
          this.anchor = { ...this.anchor, frameUrl: url };
          this.seedAlias.set(rawFrameUrl, url);
          const key = lookKey(this.anchor.state);
          if (this.trustedSeedByLook.get(key) === rawFrameUrl) {
            this.trustedSeedByLook.set(key, url);
          }
        }
      })
      .catch(() => {});
  }

  // ---- Idle lane ----

  // While a chain runs, bridge idles seed from its tail instead of the (stale) display anchor.
  private idleLaneTarget(): AnchorPoint {
    return BRIDGE_IDLES ? (this.chainTail ?? this.anchor) : this.anchor;
  }

  // Only stock seeded from the idle lane target counts toward the buffer target; others stay
  // playable until consumed (an old-anchor idle) or promoted (a bridge idle once its tail lands).
  private idleLaneTargetStockCount(): number {
    const target = this.idleLaneTarget();
    const ready = this.idleReady.filter((clip) =>
      this.sameSeed(
        this.idleAnchorByClipId.get(clip.clipId) ?? "",
        target.frameUrl,
      ),
    ).length;
    let inflight = 0;
    for (const [seed, count] of this.idleInflightBySeed) {
      if (this.sameSeed(seed, target.frameUrl)) {
        inflight += count;
      }
    }
    return ready + inflight;
  }

  private trackIdleInflight(seed: string, delta: number): void {
    this.idleInflightCount += delta;
    const next = (this.idleInflightBySeed.get(seed) ?? 0) + delta;
    if (next <= 0) {
      this.idleInflightBySeed.delete(seed);
    } else {
      this.idleInflightBySeed.set(seed, next);
    }
  }

  // Runs even while the chain lane is busy: idle filler is what covers a chain render's latency.
  private fillIdleStockpile(): void {
    if (this.disposed || this.costCapReached) {
      return;
    }
    const snapshot = this.getSnapshot;
    if (!snapshot) {
      return;
    }
    while (
      this.idleLaneTargetStockCount() < this.idleBufferTarget() &&
      this.idleInflightCount < this.idleMaxInflight()
    ) {
      this.submitIdleJob(this.idleLaneTarget(), 0);
    }
  }

  private submitIdleJob(anchorAtSubmit: AnchorPoint, attempt: number): void {
    const snapshot = this.getSnapshot;
    if (!snapshot || this.disposed || this.costCapReached) {
      return;
    }
    const request: ClipRequest = {
      session: {
        ...snapshot(),
        seedFrameUrl: anchorAtSubmit.frameUrl,
        state: anchorAtSubmit.state,
      },
      job: { kind: "idle", durationSec: this.nextIdleDurationSec() },
      // Idle is never committed as canon or reused as a seed, so use the faster turbo backend; swap mode keeps swap, or the filler (most of what plays) would show the unswapped face.
      backend: this.backend === "swap" ? "swap" : "turbo",
      speechMode: this.speechMode,
      useIdentityReference: false,
    };
    this.trackIdleInflight(anchorAtSubmit.frameUrl, 1);
    const startedAtMs = this.now();
    this.render(request).then(
      (result) => {
        this.recordIdleProduction(startedAtMs);
        this.handleIdleSettled(anchorAtSubmit, attempt, result, null);
      },
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
    this.trackIdleInflight(anchorAtSubmit.frameUrl, -1);
    if (this.disposed) {
      return;
    }

    const rejected = result !== null && result.verdict === "rejected";
    if (rejected) {
      this.onEvent({ type: "clipDiscarded", result, costUsd: result.costUsd });
      this.addCost(result.costUsd);
    }
    if (error || !result || rejected) {
      if (attempt < 1) {
        // submitIdleJob does the increment; don't double-count here, or a retried idle
        // permanently leaks one inflight slot and the stockpile eventually stalls (a freeze).
        this.submitIdleJob(anchorAtSubmit, attempt + 1);
        return;
      }
      const message = rejected
        ? (result.rejectReason ?? "idle clip rejected by frame guard")
        : error instanceof Error
          ? error.message
          : String(error);
      this.onEvent({ type: "error", job: { kind: "idle" }, message });
      this.fillIdleStockpile();
      return;
    }

    const stillCurrent =
      this.sameSeed(anchorAtSubmit.frameUrl, this.anchor.frameUrl) ||
      anchorAtSubmit.frameUrl === this.chainTail?.frameUrl;
    if (!stillCurrent) {
      // Neither the anchor nor a bridge idle's chain tail matches anymore; log the cost and drop it.
      this.onEvent({
        type: "clipDiscarded",
        result,
        costUsd: result.costUsd,
      });
      this.addCost(result.costUsd);
      this.fillIdleStockpile();
      return;
    }

    // Non-looping (reference backend) filler is one-shot and never becomes canon (director.clipCompleted
    // drops idle results), so it's safe to play even though its own end frame has drifted.
    this.idleAnchorByClipId.set(result.clipId, anchorAtSubmit.frameUrl);
    this.idleReady.push(result);
    this.onEvent({ type: "clipReady", result, lane: "idle" });
    this.addCost(result.costUsd);
    this.announceIfRecovered();
    this.fillIdleStockpile();
  }
}
