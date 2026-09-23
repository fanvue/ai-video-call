// Anchored idle buffer + chained action queue (reply -> beats -> settle). See
// docs/LIVE_ENGINE.md "Clip chain: anchors and loops" / "Request latency policy".

import {
  LIVE_TUNABLES,
  type ClipJob,
  type ClipRequest,
  type ClipResult,
  type ClipSwapReport,
  type LiveSessionSnapshot,
  type LiveState,
  type RenderBackend,
  type IntentParser,
  type SpeechMode,
  type SwapProfile,
} from "@/lib/live/contract";

export type PipelineEvent =
  // The clip is playable. A swap-mode clip fires this once its full swap has landed.
  | { type: "clipReady"; result: ClipResult; lane: "idle" | "chained" }
  // A swap-mode clip rendered and (for a chain clip) its tail is the new seed, but the clip itself is still being swapped; canon advances now, playback waits for clipReady.
  | { type: "clipRendered"; result: ClipResult; lane: "idle" | "chained" }
  // A split reply's rest is playable (swapped, or its raw frames on the fail-open); not canon, its head already was.
  | { type: "clipPartReady"; result: ClipResult }
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
  swapProfile?: SwapProfile;
  swapFaceLock?: boolean;
  swapHandMask?: boolean;
  personaId?: string;
  intentParser?: IntentParser;
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
  // Swap mode: finishes a clip whose swap.status is "pending" (the full face swap) before it may play. With rest, it swapped only the head and rest brings the frames after it.
  finalizeSwap?: (
    result: ClipResult,
  ) => Promise<SwapOutcome & { rest?: Promise<SwapOutcome> }>;
};

type SwapOutcome = {
  videoUrl: string;
  lastFrameUrl?: string;
  costUsd: number;
  report: ClipSwapReport;
};

const failedSwap = (error: unknown): ClipSwapReport => ({
  status: "failed",
  swapMs: 0,
  frames: 0,
  framesWithFace: 0,
  msPerFrame: 0,
  similarityBefore: null,
  similarityAfter: null,
  restored: false,
  reason: (error instanceof Error ? error.message : String(error)).slice(
    0,
    300,
  ),
});

export type SnapshotSource = () => LiveSessionSnapshot;

// Extra idle render per beat while a chain runs; flip off to save spend.
const BRIDGE_IDLES = true;

type AnchorPoint = { frameUrl: string; state: LiveState };

// The greeting loops on a staged in-scene still (seed differs from the identity photo) but chains off the raw upload; mirrors generateClip's rule.
export const greetingLoopsOn = (snapshot: LiveSessionSnapshot): boolean =>
  snapshot.seedFrameUrl !== snapshot.anchorFrameUrl;

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
  private readonly finalizeSwap?: ClipPipelineOptions["finalizeSwap"];
  private backend: RenderBackend;
  private speechMode: SpeechMode;
  private readonly swapProfile?: SwapProfile;
  private readonly swapFaceLock?: boolean;
  private readonly swapHandMask?: boolean;
  private readonly personaId?: string;
  private readonly intentParser?: IntentParser;

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
  // Looping idles already played; they start and end on their anchor, so any of them can follow any other seamlessly (see IDLE_DECK_SIZE).
  private idleDeck: ClipResult[] = [];
  private lastIdleClipId: string | null = null;

  private chainInflight: { job: ClipJob } | null = null;
  // Seed for the next chain job once the current one resolves; null = chain caught up with anchor.
  private chainTail: AnchorPoint | null = null;
  private chainedReady: ClipResult[] = [];
  // Clips still having their full swap finished: they hold their queue position but are not playable yet.
  private pendingSwapClipIds = new Set<string>();
  // A split reply's rest still swapping, by its clipId: nothing may play between it and its head.
  private splitRests = new Map<
    string,
    { headClipId: string; failOpen: () => void; leadMs: number }
  >();
  // A rest playing its raw frames on the fail-open starts this far into the rendered clip.
  private startSecByClipId = new Map<string, number>();
  // Containers held outside the pipeline for a split reply's rest; idle swaps leave them free.
  private heldSwapSlots = 0;
  private consecutiveSwapFailures = 0;
  private pendingChainSwaps = 0;
  private activeSwaps = 0;
  private activeChainSwaps = 0;
  private queuedSwaps: Array<{
    lane: "idle" | "chained";
    run: () => void;
    result: ClipResult;
  }> = [];
  // Chain swaps waiting for the one before them to land; see beginPendingSwap.
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
  // Wall time of the last few idle productions (render + swap + rehost), so the next idle can be made at least that long.
  private idleProductionMs: number[] = [];

  constructor(options: ClipPipelineOptions) {
    this.render = options.render;
    this.now = options.now;
    this.onEvent = options.onEvent;
    this.abandonDependents = options.abandonDependents;
    this.upscaleSeed = options.upscaleSeed;
    this.needsIdentityReference = options.needsIdentityReference;
    this.finalizeSwap = options.finalizeSwap;
    this.backend = options.backend ?? "turbo";
    this.speechMode = options.speechMode ?? "text";
    this.swapProfile = options.swapProfile;
    this.swapFaceLock = options.swapFaceLock;
    this.swapHandMask = options.swapHandMask;
    this.personaId = options.personaId;
    this.intentParser = options.intentParser;
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
    return [...this.idleReady, ...this.chainedReady]
      .filter((clip) => this.isPlayable(clip))
      .reduce((sum, clip) => sum + clip.durationSec, 0);
  }

  private isPlayable(clip: ClipResult): boolean {
    return !this.pendingSwapClipIds.has(clip.clipId);
  }

  // Two-phase swap: the result is on the shelf with its tail as the seed, so the chain and fillers move on now; the clip becomes playable when the full swap lands, and plays unswapped if that fails.
  private beginPendingSwap(
    result: ClipResult,
    lane: "idle" | "chained",
  ): boolean {
    const finalizeSwap = this.finalizeSwap;
    if (result.swap?.status !== "pending" || !finalizeSwap) {
      return false;
    }
    // The greeting has nothing else buffered yet, so gating it on its own full swap is dead air on first join; it plays unswapped. Its swap is not run in the background either: prod landed it 0.2 s after the greeting finished, having held one of the two GPUs the first idles were queueing for.
    if (result.jobKind === "greeting") {
      return false;
    }
    this.pendingSwapClipIds.add(result.clipId);
    if (lane === "chained") {
      this.pendingChainSwaps += 1;
    }
    this.onEvent({ type: "clipRendered", result, lane });
    const renderedVideoUrl = result.videoUrl;
    const runSwap = () =>
      finalizeSwap(result)
        .then(
          (swapped) => {
            result.videoUrl = swapped.videoUrl;
            result.swap = swapped.report;
            result.costUsd += swapped.costUsd;
            this.addCost(swapped.costUsd);
            if (swapped.rest) {
              this.beginSplitRest(result, renderedVideoUrl, swapped.rest);
            }
          },
          (error: unknown) => {
            result.swap = failedSwap(error);
          },
        )
        .then(() => {
          if (this.disposed) {
            return;
          }
          this.pendingSwapClipIds.delete(result.clipId);
          this.activeSwaps -= 1;
          if (lane === "chained") {
            this.pendingChainSwaps -= 1;
            this.activeChainSwaps -= 1;
          }
          this.dispatchSwaps();
          const swapFailed = result.swap?.status === "failed";
          this.consecutiveSwapFailures = swapFailed
            ? this.consecutiveSwapFailures + 1
            : 0;
          // An unswapped idle shows the raw render's face for a whole clip, so a one-off failure is dropped and restocked; once swaps keep failing (service down) dropping would starve the player, so they play unswapped.
          if (
            lane === "idle" &&
            swapFailed &&
            this.consecutiveSwapFailures <= 1
          ) {
            this.idleReady = this.idleReady.filter(
              (clip) => clip.clipId !== result.clipId,
            );
            this.idleAnchorByClipId.delete(result.clipId);
            this.onEvent({
              type: "clipDiscarded",
              result,
              costUsd: result.costUsd,
            });
            this.fillIdleStockpile();
            return;
          }
          this.onEvent({ type: "clipReady", result, lane });
          this.announceIfRecovered();
          this.fillIdleStockpile();
        });
    this.queuedSwaps.push({ lane, run: runSwap, result });
    this.dispatchSwaps();
    return true;
  }

  // Swaps run at most SWAP_MAX_CONCURRENT at a time (one per GPU; a third request queued inside Modal and stretched a reply's swap to 12 s). One slot is always kept for the chain so a reply never waits behind fillers; chain clips play in order, so chain swaps also run one at a time.
  private dispatchSwaps(): void {
    const max = LIVE_TUNABLES.SWAP_MAX_CONCURRENT;
    if (LIVE_TUNABLES.SWAP_SKIP_STALE_IDLE_SWAPS) {
      this.skipStaleIdleSwaps();
    }
    for (;;) {
      const chainIndex = this.queuedSwaps.findIndex(
        (q) => q.lane === "chained",
      );
      const idleIndex = this.nextIdleSwapIndex();
      const activeIdleSwaps = this.activeSwaps - this.activeChainSwaps;
      let index = -1;
      if (
        chainIndex !== -1 &&
        this.activeChainSwaps < LIVE_TUNABLES.SWAP_CHAIN_MAX_CONCURRENT &&
        this.activeSwaps < max
      ) {
        index = chainIndex;
      } else if (
        idleIndex !== -1 &&
        activeIdleSwaps + this.heldSwapSlots < max - 1
      ) {
        index = idleIndex;
      }
      if (index === -1) {
        return;
      }
      const [next] = this.queuedSwaps.splice(index, 1);
      if (!next) {
        return;
      }
      this.activeSwaps += 1;
      if (next.lane === "chained") {
        this.activeChainSwaps += 1;
      }
      next.run();
    }
  }

  // The filler that covers the frame playback is on now goes first; the rest keep submit order.
  private nextIdleSwapIndex(): number {
    const onCursor = this.queuedSwaps.findIndex(
      (q) =>
        q.lane === "idle" &&
        this.sameSeed(
          this.idleAnchorByClipId.get(q.result.clipId) ?? "",
          this.playoutCursorFrameUrl,
        ),
    );
    return onCursor !== -1
      ? onCursor
      : this.queuedSwaps.findIndex((q) => q.lane === "idle");
  }

  // Swaps in flight on the pipeline's slots plus containers held for a split rest.
  swapLoad(): number {
    return this.activeSwaps + this.heldSwapSlots;
  }

  // Holds a container for a split reply's rest until the returned release runs; idle swaps wait, chain swaps do not.
  holdSwapSlot(): () => void {
    this.heldSwapSlots += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.heldSwapSlots -= 1;
      if (!this.disposed) {
        this.dispatchSwaps();
      }
    };
  }

  // Where the player starts a clip, when not at 0: a split rest playing its raw frames.
  startSecFor(clipId: string): number | undefined {
    return this.startSecByClipId.get(clipId);
  }

  // The head is playable now; the rest queues right behind it and plays when its swap lands, or its raw frames once it is late or failed.
  private beginSplitRest(
    head: ClipResult,
    renderedVideoUrl: string,
    rest: Promise<SwapOutcome>,
  ): void {
    const report = head.swap;
    const index = this.chainedReady.indexOf(head);
    const headSec = report?.fps ? report.frames / report.fps : 0;
    // A head that fell back to the whole unswapped clip already covers every frame; so does one from a swap service that ignored the range (not yet deployed), or the reply would play twice.
    if (
      report?.status !== "swapped" ||
      headSec <= 0 ||
      headSec >= head.durationSec - 0.5 ||
      index === -1
    ) {
      void rest.then(
        (swapped) => {
          this.addCost(swapped.costUsd);
          this.onEvent({
            type: "clipDiscarded",
            result: head,
            costUsd: swapped.costUsd,
          });
        },
        () => undefined,
      );
      return;
    }
    const part: ClipResult = {
      ...head,
      clipId: `${head.clipId}:rest`,
      videoUrl: renderedVideoUrl,
      durationSec: Math.max(0, head.durationSec - headSec),
      costUsd: 0,
      swap: { ...report, status: "pending" },
    };
    head.durationSec = headSec;
    this.chainedReady.splice(index + 1, 0, part);
    this.pendingSwapClipIds.add(part.clipId);
    let settled = false;
    const finish = (outcome: SwapOutcome | null, failure: unknown) => {
      settled = true;
      this.splitRests.delete(part.clipId);
      if (this.disposed) {
        return;
      }
      if (outcome?.report.status === "swapped") {
        part.videoUrl = outcome.videoUrl;
        part.swap = outcome.report;
      } else {
        this.startSecByClipId.set(part.clipId, headSec);
        part.swap = outcome?.report ?? failedSwap(failure);
      }
      this.pendingSwapClipIds.delete(part.clipId);
      this.onEvent({ type: "clipPartReady", result: part });
      this.announceIfRecovered();
    };
    this.splitRests.set(part.clipId, {
      headClipId: head.clipId,
      failOpen: () => {
        if (!settled) {
          finish(null, new Error("split rest late, playing its raw frames"));
        }
      },
      leadMs: Math.max(
        0,
        headSec * 1000 - LIVE_TUNABLES.SWAP_SPLIT_REST_LEAD_MS,
      ),
    });
    rest.then(
      (swapped) => {
        this.addCost(swapped.costUsd);
        if (settled) {
          this.onEvent({
            type: "clipDiscarded",
            result: part,
            costUsd: swapped.costUsd,
          });
          return;
        }
        part.costUsd = swapped.costUsd;
        finish(swapped, null);
      },
      (error: unknown) => {
        if (!settled) {
          finish(null, error);
        }
      },
    );
  }

  // Frames playback can still stand on: now, after a chain clip already on the shelf, or at the chain's tail and anchor.
  private idleAnchorCanPlay(frameUrl: string): boolean {
    return (
      this.sameSeed(frameUrl, this.playoutCursorFrameUrl) ||
      this.sameSeed(frameUrl, this.anchor.frameUrl) ||
      frameUrl === this.chainTail?.frameUrl ||
      this.chainedReady.some((clip) =>
        this.sameSeed(frameUrl, clip.seedFrameUrl),
      )
    );
  }

  // A queued filler that can never play is dropped before it takes a swap slot; its render is already spent, so it is reported like any other discarded clip.
  private skipStaleIdleSwaps(): void {
    const stale = this.queuedSwaps.filter(
      (q) =>
        q.lane === "idle" &&
        !this.idleAnchorCanPlay(
          this.idleAnchorByClipId.get(q.result.clipId) ?? "",
        ),
    );
    if (stale.length === 0) {
      return;
    }
    this.queuedSwaps = this.queuedSwaps.filter((q) => !stale.includes(q));
    for (const { result } of stale) {
      this.pendingSwapClipIds.delete(result.clipId);
      this.idleReady = this.idleReady.filter(
        (clip) => clip.clipId !== result.clipId,
      );
      this.idleAnchorByClipId.delete(result.clipId);
      this.onEvent({ type: "clipDiscarded", result, costUsd: result.costUsd });
    }
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
    // Only reference re-seeds back to the starting frame at a plan end; elsewhere the trusted frame is registered on promotion.
    if (this.backend === "reference") {
      this.trustedSeedByLook.set(
        lookKey(snapshot.state),
        snapshot.seedFrameUrl,
      );
    }
    this.displayAnchorFrameUrl = snapshot.seedFrameUrl;
    this.playoutCursorFrameUrl = snapshot.seedFrameUrl;
    this.submitChainJob(initialJob, 0);
    // Pre-stocked fillers seed from the starting frame, so they only pay off where the greeting lands back on it: reference re-seeds to it, and on a staged seed the greeting loops (see generateClip). Swap mode waits for the greeting instead: its loop covers the gap, and fillers swapping alongside it doubled the join.
    if (
      this.backend === "reference" ||
      (this.backend !== "swap" && greetingLoopsOn(snapshot))
    ) {
      this.fillIdleStockpile();
    }
  }

  // A one-shot clip is ending with nothing seeded from its tail ready: the least bad continuation is an idle of the same look, played as a cut rather than a freeze. Prefers the newest anchor.
  nextFallbackClip(): ClipResult | null {
    // A chain clip whose swap is still landing follows the tail frame for frame; an old-anchor idle does not. Prod showed the fallback cut and then the chain clip cutting into it 0.6 s later, two pose jumps for one boundary, so the player holds the last frame instead.
    const chained = this.chainedReady[0];
    if (chained !== undefined && !this.isPlayable(chained)) {
      return null;
    }
    const key = lookKey((this.chainTail ?? this.anchor).state);
    for (let i = this.idleReady.length - 1; i >= 0; i -= 1) {
      const clip = this.idleReady[i];
      if (clip && this.isPlayable(clip) && lookKey(clip.state) === key) {
        this.idleReady.splice(i, 1);
        this.fillIdleStockpile();
        return clip;
      }
    }
    return null;
  }

  // Try to run the just-queued job now; if the chain lane is busy it's picked up when it frees.
  onRequestEnqueued(): void {
    this.tryAdvanceChain();
  }

  // Call after director.tick() so timer-driven jobs (redress / checkIn) get picked up too.
  pollChain(): void {
    this.tryAdvanceChain();
  }

  // A requested clip is waiting; the player cuts into a looping idle for it rather than queueing behind it. Only once it can play: a cut-in for a clip still swapping pulled an idle off the shelf and dropped it.
  hasChainedReady(): boolean {
    const chained = this.chainedReady[0];
    return chained !== undefined && this.isPlayable(chained);
  }

  // The player hands back a clip it pulled but will not play (an idle displaced by a cut-in).
  requeue(clip: ClipResult): void {
    if (clip.jobKind === "idle") {
      // A deck replay handed back is still in the deck; a fresh idle goes back to the front of the shelf.
      if (this.idleDeck.includes(clip)) {
        return;
      }
      this.idleReady.unshift(clip);
      return;
    }
    this.chainedReady.unshift(clip);
  }

  // Playback boundary selection: eligibility is purely seed-frame match against the display anchor.
  nextClip(): ClipResult | null {
    const clip = this.pickNext();
    if (!clip) {
      // The head is still on screen with its rest due, so this is not an empty buffer.
      const holdingForRest =
        this.chainedReady[0] !== undefined &&
        this.splitRests.has(this.chainedReady[0].clipId);
      if (!this.bufferIsEmpty && !holdingForRest) {
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
    // Order is canon: a later chain clip must not jump ahead of one still being swapped. An idle anchored on the cursor is not a jump, it loops back to the frame the pending clip starts from, so it covers the wait instead of a frozen frame (prod held 21 s on the greeting's last frame while a reply swapped).
    if (chained && this.isPlayable(chained)) {
      this.chainedReady.shift();
      this.firstChainClipPlayed = true;
      this.playoutCursorFrameUrl = chained.seedFrameUrl;
      this.fillIdleStockpile();
      return chained;
    }
    // A split rest continues its head frame for frame; an idle between them would jump to the reply's end pose and back.
    if (chained && this.splitRests.has(chained.clipId)) {
      return null;
    }
    if (!this.firstChainClipPlayed) {
      return null;
    }
    // Idles loop back to their anchor, so handing one out leaves the cursor where it was.
    // An idle rendered from the exact cursor frame is seamless; one from its trusted alias is a small cut, so it is the fallback.
    const exactIndex = this.idleReady.findIndex(
      (clip) =>
        this.isPlayable(clip) &&
        this.idleAnchorByClipId.get(clip.clipId) === this.playoutCursorFrameUrl,
    );
    const idleIndex =
      exactIndex !== -1
        ? exactIndex
        : this.idleReady.findIndex(
            (clip) =>
              this.isPlayable(clip) &&
              this.sameSeed(
                this.idleAnchorByClipId.get(clip.clipId) ?? "",
                this.playoutCursorFrameUrl,
              ),
          );
    if (idleIndex !== -1) {
      const [clip] = this.idleReady.splice(idleIndex, 1);
      if (clip) {
        if (clip.loops) {
          this.idleDeck.push(clip);
        }
        this.lastIdleClipId = clip.clipId;
      }
      this.fillIdleStockpile();
      return clip;
    }
    return this.replayFromDeck();
  }

  // No fresh idle for this anchor: replay a played one, never the one just shown, so the loop reads as varied rather than repeated.
  private replayFromDeck(): ClipResult | null {
    const candidates = this.idleDeck.filter(
      (clip) =>
        clip.clipId !== this.lastIdleClipId &&
        this.isPlayable(clip) &&
        this.sameSeed(
          this.idleAnchorByClipId.get(clip.clipId) ?? "",
          this.playoutCursorFrameUrl,
        ),
    );
    const clip = candidates[Math.floor(Math.random() * candidates.length)];
    if (!clip) {
      return null;
    }
    this.lastIdleClipId = clip.clipId;
    return clip;
  }

  private deckCountFor(frameUrl: string): number {
    return this.idleDeck.filter((clip) =>
      this.sameSeed(this.idleAnchorByClipId.get(clip.clipId) ?? "", frameUrl),
    ).length;
  }

  private hasPlayable(): boolean {
    return (
      (this.chainedReady[0] !== undefined &&
        this.isPlayable(this.chainedReady[0])) ||
      (this.firstChainClipPlayed &&
        [...this.idleReady, ...this.idleDeck].some(
          (clip) =>
            this.isPlayable(clip) &&
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
  onClipStarted(seedFrameUrl: string, clipId?: string): void {
    this.displayAnchorFrameUrl = seedFrameUrl;
    // The head is on screen: its rest must be playable before the head ends, or the boundary freezes.
    for (const rest of this.splitRests.values()) {
      if (rest.headClipId === clipId) {
        setTimeout(rest.failOpen, rest.leadMs);
      }
    }
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
    } else if (this.backend !== "reference") {
      // Turbo and swap have no identity reference pulling the tail back toward the seed, so a re-seed there is a hard jump; continuity wins over drift. A timed scene reset was tried and reverted for that pop.
    } else if (trusted !== tail.frameUrl) {
      this.seedAlias.set(tail.frameUrl, trusted);
      newAnchor = { ...tail, frameUrl: trusted };
    }
    this.anchor = newAnchor;
    // Idles of an earlier pose can never follow this anchor again.
    this.idleDeck = this.idleDeck.filter((clip) =>
      this.sameSeed(
        this.idleAnchorByClipId.get(clip.clipId) ?? "",
        newAnchor.frameUrl,
      ),
    );
    this.onEvent({
      type: "anchorChanged",
      frameUrl: newAnchor.frameUrl,
      state: newAnchor.state,
      atMs: this.now(),
    });
    this.fillIdleStockpile();
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
      swapProfile: this.swapProfile,
      swapFaceLock: this.swapFaceLock,
      swapHandMask: this.swapHandMask,
      personaId: this.personaId,
      intentParser: this.intentParser,
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
    // Registered before the fillers below, or they see no chain swap in flight and take the full inflight budget; prod then ran two filler swaps alongside the reply's.
    const swapPending = this.beginPendingSwap(result, "chained");
    // Bridge idles from the new tail can start rendering right away, alongside the next beat.
    this.fillIdleStockpile();
    if (!swapPending) {
      this.onEvent({ type: "clipReady", result, lane: "chained" });
    }
    this.addCost(result.costUsd);
    this.announceIfRecovered();
    this.tryAdvanceChain();
    // Swap mode's service restores the seed frame itself (services/swap enhance_frame); the fal upscaler timed out on every prod call.
    if (
      this.backend !== "swap" &&
      this.now() - this.lastUpscaleAtMs >= LIVE_TUNABLES.UPSCALE_INTERVAL_MS
    ) {
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

  // A settled pose whose deck is full replays it instead of rendering more; a bridge idle for a chain tail only covers until the chain moves on.
  private deckFull(target: AnchorPoint): boolean {
    return (
      this.chainTail === null &&
      this.deckCountFor(target.frameUrl) >= LIVE_TUNABLES.IDLE_DECK_SIZE
    );
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
    // The swap service takes one clip at a time (6 to 7 s each), and prod showed replies queueing 7 to 15 s behind fillers submitted while they rendered. While a request is in flight, fillers wait unless the shelf is bare.
    const chainSwapActive =
      this.backend === "swap" &&
      (this.chainInflight || this.pendingChainSwaps > 0);
    // Only a playable idle on the current target anchor counts as cover: an old-anchor idle cannot follow the new tail, and counting it left a beat's bridge idle unsubmitted for 39 s in prod, so the beat's end held for 8 s.
    const target = this.idleLaneTarget();
    const targetCovered = this.idleReady.some(
      (clip) =>
        this.isPlayable(clip) &&
        this.sameSeed(
          this.idleAnchorByClipId.get(clip.clipId) ?? "",
          target.frameUrl,
        ),
    );
    if ((chainSwapActive && targetCovered) || this.deckFull(target)) {
      return;
    }
    // A bare shelf still needs covering, but the account's swap capacity only sustains one chain swap plus one filler at a time; piling the full idle inflight budget on top of a chain swap is what queued replies 15-20s behind fillers.
    const inflightCap = chainSwapActive ? 1 : this.idleMaxInflight();
    while (
      this.idleLaneTargetStockCount() < this.idleBufferTarget() &&
      this.idleInflightCount < inflightCap
    ) {
      this.submitIdleJob(target, 0);
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
      job: {
        kind: "idle",
        durationSec: this.nextIdleDurationSec(),
        variant:
          this.idleLaneTargetStockCount() +
          this.deckCountFor(anchorAtSubmit.frameUrl),
      },
      // Idle is never committed as canon or reused as a seed, so use the faster turbo backend; swap mode keeps swap, or the filler (most of what plays) would show the unswapped face.
      backend: this.backend === "swap" ? "swap" : "turbo",
      speechMode: this.speechMode,
      swapProfile: this.swapProfile,
      swapFaceLock: this.swapFaceLock,
      swapHandMask: this.swapHandMask,
      personaId: this.personaId,
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
    if (!this.beginPendingSwap(result, "idle")) {
      this.onEvent({ type: "clipReady", result, lane: "idle" });
    }
    this.addCost(result.costUsd);
    this.announceIfRecovered();
    this.fillIdleStockpile();
  }
}
