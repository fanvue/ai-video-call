// 1-ahead clip chain: exactly one in-flight job, at most one ready clip buffered. See
// docs/LIVE_ENGINE.md "Clip chain invariants" and "Request latency policy".

import {
  LIVE_TUNABLES,
  type ClipJob,
  type ClipRequest,
  type ClipResult,
  type LiveSessionSnapshot,
  type RenderBackend,
  type SpeechMode,
} from "@/lib/live/contract";

export type PipelineEvent =
  | { type: "clipReady"; result: ClipResult }
  | { type: "clipAbandoned"; job: ClipJob; costUsd: number }
  | { type: "error"; job: ClipJob; message: string }
  | { type: "bufferEmpty" };

export type ClipPipelineOptions = {
  render: (req: ClipRequest) => Promise<ClipResult>;
  now: () => number;
  onEvent: (event: PipelineEvent) => void;
  backend?: RenderBackend;
  speechMode?: SpeechMode;
};

type InFlight = {
  job: ClipJob;
  startedAt: number;
  attempt: number;
  abandoned: boolean;
};

export type SnapshotSource = () => LiveSessionSnapshot;

export class ClipPipeline {
  private readonly render: ClipPipelineOptions["render"];
  private readonly now: () => number;
  private readonly onEvent: (event: PipelineEvent) => void;
  private backend: RenderBackend;
  private speechMode: SpeechMode;

  private inFlight: InFlight | null = null;
  private ready: ClipResult | null = null;
  private getSnapshot: SnapshotSource | null = null;
  private getNextJob: (() => ClipJob) | null = null;
  private disposed = false;
  // False until the first clip ever lands, so the initial fill-from-empty isn't itself reported
  // as a stall; true afterwards, so a later gap (consumer drained the buffer before N+1 arrived) is.
  private hasDeliveredReady = false;

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

  isBusy(): boolean {
    return this.inFlight !== null;
  }

  takeReady(): ClipResult | null {
    const result = this.ready;
    this.ready = null;
    return result;
  }

  peekReady(): ClipResult | null {
    return this.ready;
  }

  // Stops the chain from submitting further renders; a settle already in flight is dropped on arrival.
  dispose(): void {
    this.disposed = true;
  }

  // Kicks off the chain and wires the sources it pulls from every time it submits the next job.
  start(
    job: ClipJob,
    getSnapshot: SnapshotSource,
    getNextJob: () => ClipJob,
  ): void {
    this.getSnapshot = getSnapshot;
    this.getNextJob = getNextJob;
    this.submit(job, 0);
  }

  // A fan request preempts a young in-flight idle: abandon it (cost still reported, result
  // discarded) and submit the reply from the same seed. Otherwise it waits in the director queue.
  onRequestEnqueued(replyJob: ClipJob): void {
    if (!this.inFlight) {
      this.submit(replyJob, 0);
      return;
    }
    const age = this.now() - this.inFlight.startedAt;
    if (
      this.inFlight.job.kind === "idle" &&
      age < LIVE_TUNABLES.ABANDON_INFLIGHT_MS
    ) {
      this.inFlight.abandoned = true;
      this.submit(replyJob, 0);
    }
  }

  private submit(job: ClipJob, attempt: number): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.getSnapshot;
    if (!snapshot) {
      return;
    }
    const request: ClipRequest = {
      session: snapshot(),
      job,
      backend: this.backend,
      speechMode: this.speechMode,
    };
    const entry: InFlight = {
      job,
      startedAt: this.now(),
      attempt,
      abandoned: false,
    };
    this.inFlight = entry;
    this.render(request).then(
      (result) => this.handleSettled(entry, result, null),
      (error: unknown) => this.handleSettled(entry, null, error),
    );
  }

  private handleSettled(
    entry: InFlight,
    result: ClipResult | null,
    error: unknown,
  ): void {
    // Must run before the `this.inFlight !== entry` staleness check: abandon already replaced inFlight with a newer job, so that check would wrongly drop this report.
    if (entry.abandoned) {
      this.onEvent({
        type: "clipAbandoned",
        job: entry.job,
        costUsd: result?.costUsd ?? 0,
      });
      this.advance();
      return;
    }

    if (this.inFlight !== entry) {
      return;
    }
    this.inFlight = null;
    if (this.disposed) {
      return;
    }

    if (error || !result) {
      if (entry.attempt < 1) {
        this.submit(entry.job, entry.attempt + 1);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.onEvent({ type: "error", job: entry.job, message });
      this.submit({ kind: "idle" }, 0);
      return;
    }

    const wasStarved = this.hasDeliveredReady && this.ready === null;
    this.ready = result;
    this.hasDeliveredReady = true;
    this.onEvent({ type: "clipReady", result });
    if (wasStarved) {
      this.onEvent({ type: "bufferEmpty" });
    }
    this.advance();
  }

  // Submits N+1 the instant N resolves. A request that arrived mid-flight was already pushed to
  // the front of the director's queue, so pulling nextJob() here picks it up next automatically.
  private advance(): void {
    if (this.inFlight) {
      return;
    }
    const nextJob = this.getNextJob;
    if (!nextJob) {
      return;
    }
    this.submit(nextJob(), 0);
  }
}
