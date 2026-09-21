import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipPipeline, type PipelineEvent } from "./pipeline";
import { LIVE_TUNABLES } from "@/lib/live/contract";
import type {
  ClipJob,
  ClipRequest,
  ClipResult,
  LiveSessionSnapshot,
  LiveState,
} from "@/lib/live/contract";

const baseBody = {
  pose: "sitting" as const,
  facing: "camera" as const,
  hands: "free" as const,
  contact: "none" as const,
  prop: "none" as const,
  framing: "medium" as const,
};

const liveState: LiveState = {
  wardrobe: {
    top: { on: true, description: "top" },
    bottom: { on: true, description: "bottom" },
    bra: { on: true, description: "bra" },
    panties: { on: true, description: "panties" },
    removedOrder: [],
  },
  body: baseBody,
  baselineBody: baseBody,
  world: "w",
  surroundings: "s",
};

const ANCHOR_0 = "https://example.com/anchor-0.jpg";

const snapshot: LiveSessionSnapshot = {
  creator: {
    id: "c1",
    displayName: "Her",
    lookLock: "",
    sceneId: "bedroom",
    tipMenu: [],
  },
  state: liveState,
  seedFrameUrl: ANCHOR_0,
  anchorFrameUrl: ANCHOR_0,
  elapsedSec: 0,
  transcript: [],
};

let resultCounter = 0;
let frameCounter = 0;
// A chain job (greeting/reply/beat/settle/...) always moves to a fresh frame; an idle loop always
// returns to the frame it started from (that's what makes it a loop).
const freshFrame = () => `https://example.com/frame-${++frameCounter}.jpg`;

const makeResult = (
  jobKind: ClipResult["jobKind"],
  seedFrameUrl: string,
  overrides: Partial<ClipResult> = {},
): ClipResult => {
  resultCounter += 1;
  return {
    clipId: `clip-${resultCounter}`,
    jobKind,
    videoUrl: `https://example.com/${resultCounter}.mp4`,
    durationSec: 10,
    seedFrameUrl,
    loops: true,
    state: liveState,
    reply: null,
    followUps: [],
    guard: { checked: true, issues: [], repaired: false },
    timings: { planMs: 1, renderMs: 1, frameMs: 1, guardMs: 1, repairMs: 1 },
    costUsd: 0.02,
    ...overrides,
  };
};

// Default fake render: idle and greeting echo their input seed (loops, as on turbo), everything
// else advances to a fresh frame (a chain step). Tests override this to control timing/outcome.
const chainAdvancingResult = (req: ClipRequest): ClipResult =>
  req.job.kind === "idle" || req.job.kind === "greeting"
    ? makeResult(req.job.kind, req.session.seedFrameUrl)
    : makeResult(req.job.kind, freshFrame());

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

const defer = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// A render that resolves via a fake timer, so instant-resolving fakes don't spin the pipeline
// forever (it resubmits idles the instant one settles).
const RENDER_DELAY_MS = 10;
const delayed = <T>(value: () => T): Promise<T> =>
  new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(value());
      } catch (error) {
        reject(error);
      }
    }, RENDER_DELAY_MS);
  });

// Minimal stand-in for LiveDirector's queue: returns queued jobs in order, "idle" once drained.
const makeJobQueue = () => {
  const queue: ClipJob[] = [];
  return {
    push: (job: ClipJob) => queue.push(job),
    next: (): ClipJob => queue.shift() ?? { kind: "idle" },
  };
};

const REPLY_JOB: ClipJob = {
  kind: "reply",
  requestId: "r1",
  text: "hi",
  channel: "chat",
  from: "fan",
};

describe("ClipPipeline", () => {
  let now: number;
  const nowFn = () => now;
  const pipelines: ClipPipeline[] = [];
  const trackedPipeline = (
    options: ConstructorParameters<typeof ClipPipeline>[0],
  ) => {
    const pipeline = new ClipPipeline(options);
    pipelines.push(pipeline);
    return pipeline;
  };

  beforeEach(() => {
    now = 0;
    resultCounter = 0;
    frameCounter = 0;
    pipelines.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const pipeline of pipelines) {
      pipeline.dispose();
    }
    vi.useRealTimers();
  });

  it("idle stockpile reaches IDLE_BUFFER_TARGET and never exceeds IDLE_MAX_INFLIGHT", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    // On turbo the greeting loops on the reference frame, so idles pre-stock alongside it.
    expect(pipeline.getBufferStats().idleInflight).toBe(
      LIVE_TUNABLES.IDLE_MAX_INFLIGHT,
    );
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, promotes anchor
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // idle jobs resolve
    const stats = pipeline.getBufferStats();
    expect(stats.idleReady).toBe(LIVE_TUNABLES.IDLE_BUFFER_TARGET);
    expect(stats.idleInflight).toBe(0);
    // 1 greeting + IDLE_BUFFER_TARGET idles, never more in flight than IDLE_MAX_INFLIGHT at once.
    expect(requests.length).toBe(1 + LIVE_TUNABLES.IDLE_BUFFER_TARGET);
  });

  it("submits a reply immediately without waiting for in-flight idles", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const idleDeferred = defer<ClipResult>();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        if (req.job.kind === "idle") {
          return idleDeferred.promise;
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, idles submitted (in flight forever)
    expect(pipeline.getBufferStats().idleInflight).toBeGreaterThan(0);

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();

    expect(requests.some((r) => r.job.kind === "reply")).toBe(true);
  });

  it("plays old-anchor idles until the reply is ready, then plays the reply", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => delayed(() => chainAdvancingResult(req)),
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> anchor A1
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // idles from A1 ready

    const greetingClip = pipeline.nextClip();
    expect(greetingClip?.jobKind).toBe("greeting");
    const anchorA1 = greetingClip?.seedFrameUrl;

    const beforeReply = pipeline.nextClip();
    expect(beforeReply?.jobKind).toBe("idle");
    expect(beforeReply?.seedFrameUrl).toBe(anchorA1);

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply resolves, chain drains, anchor -> A2

    const afterReply = pipeline.nextClip();
    expect(afterReply?.jobKind).toBe("reply");
    expect(afterReply?.seedFrameUrl).not.toBe(anchorA1);
    expect(events.some((e) => e.type === "anchorChanged")).toBe(true);
  });

  it("chains followUps and settle in order, each seeded from the previous result", async () => {
    const seeds: string[] = [];
    const queue = makeJobQueue();
    const beat: ClipJob = {
      kind: "beat",
      beat: {
        id: "b1",
        physical: "she waves",
        durationSec: 10,
        nextState: { wardrobe: liveState.wardrobe, body: baseBody },
      },
    };
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        // Only the chain lane's seeding order is under test; idle refill also seeds off the anchor.
        if (req.job.kind !== "idle") {
          seeds.push(req.session.seedFrameUrl);
        }
        if (req.job.kind === "reply") {
          queue.push(beat);
        } else if (req.job.kind === "beat") {
          queue.push({ kind: "settle" });
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // beat
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // settle

    // greeting loops on the initial anchor so the reply seeds from it too; each later step seeds
    // from the previous step's own freshly-rendered frame.
    expect(seeds).toHaveLength(4);
    expect(seeds[0]).toBe(ANCHOR_0);
    expect(seeds[1]).toBe(ANCHOR_0);
    expect(seeds[2]).not.toBe(seeds[1]);
    expect(seeds[3]).not.toBe(seeds[2]);
  });

  it("never plays a new-anchor idle before the last chained clip has played", async () => {
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => delayed(() => chainAdvancingResult(req)),
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> A1
    pipeline.nextClip(); // consume the greeting so playback is caught up to A1

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply resolves -> anchor A2
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // new idles from A2 may already be ready

    // The chained reply must come out before any A2 idle, even though A2 idles may already be
    // sitting in the ready pool.
    const first = pipeline.nextClip();
    expect(first?.jobKind).toBe("reply");
    const second = pipeline.nextClip();
    expect(second?.jobKind).toBe("idle");
    expect(second?.seedFrameUrl).toBe(first?.seedFrameUrl);
  });

  it("discards an idle result whose seed no longer matches the current anchor", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const idleDeferred = defer<ClipResult>();
    let idleRequestSeed = "";
    // Only the initial idle-stockpile fill (IDLE_BUFFER_TARGET slots) is held pending; anything
    // submitted after that resolves normally, so a discard doesn't trigger another stale one.
    let idleCallCount = 0;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        if (req.job.kind === "idle") {
          idleCallCount += 1;
          if (idleCallCount <= LIVE_TUNABLES.IDLE_BUFFER_TARGET) {
            idleRequestSeed = req.session.seedFrameUrl;
            return idleDeferred.promise;
          }
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> A1, idles submitted (pending)

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply resolves -> anchor A2

    idleDeferred.resolve(makeResult("idle", idleRequestSeed)); // stale: seeded from old anchor A1
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // replacement idles resolve normally

    expect(events.some((e) => e.type === "clipDiscarded")).toBe(true);
    expect(pipeline.getBufferStats().idleReady).toBe(
      LIVE_TUNABLES.IDLE_BUFFER_TARGET,
    );
  });

  it("retries a failed idle render once per slot, then reports and drops each", async () => {
    const events: PipelineEvent[] = [];
    let attempts = 0;
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        if (req.job.kind !== "idle") {
          return delayed(() => chainAdvancingResult(req));
        }
        attempts += 1;
        return delayed(() => {
          throw new Error("render failed");
        });
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // idle attempt 1s fail, retry
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // idle attempt 2s fail, report + drop

    // IDLE_BUFFER_TARGET concurrent idle slots, each retried once before being dropped.
    expect(attempts).toBe(2 * LIVE_TUNABLES.IDLE_BUFFER_TARGET);
    expect(events.filter((e) => e.type === "error")).toHaveLength(
      LIVE_TUNABLES.IDLE_BUFFER_TARGET,
    );
    expect(pipeline.getBufferStats().idleReady).toBe(0);
  });

  it("abandons the rest of a chain on repeated failure, draining stale follow-on jobs", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const beat: ClipJob = {
      kind: "beat",
      beat: {
        id: "b1",
        physical: "she waves",
        durationSec: 10,
        nextState: { wardrobe: liveState.wardrobe, body: baseBody },
      },
    };
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        if (req.job.kind === "reply") {
          queue.push(beat); // as the director would, before the reply is known to have failed
          return delayed(() => {
            throw new Error("reply failed");
          });
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting
    pipeline.nextClip(); // drain the greeting so it doesn't skew the chainedReady count below

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 1 fails, retries
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 2 fails, abandons + drains beat

    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(pipeline.getBufferStats().chainedReady).toBe(0);
    // The queued beat was drained rather than left to run later from a seed that never rendered.
    expect(queue.next()).toEqual({ kind: "idle" });
  });

  it("keeps a reference-backend (loops: false) idle result as playable filler instead of discarding it", async () => {
    const events: PipelineEvent[] = [];
    let concurrentIdle = 0;
    let maxConcurrentIdle = 0;
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      backend: "reference",
      render: async (req) => {
        if (req.job.kind !== "idle") {
          return delayed(() => chainAdvancingResult(req));
        }
        concurrentIdle += 1;
        return delayed(() => {
          maxConcurrentIdle = Math.max(maxConcurrentIdle, concurrentIdle);
          concurrentIdle -= 1;
          // Reference backend can't loop: its end frame drifts from whatever it was seeded with.
          return makeResult("idle", freshFrame(), { loops: false });
        });
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> anchor A1, initial idles (seeded from ANCHOR_0) go stale
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // replacement idles resolve against A1
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // stockpile stays topped up at full concurrency

    expect(maxConcurrentIdle).toBe(LIVE_TUNABLES.IDLE_MAX_INFLIGHT);
    expect(pipeline.getBufferStats().idleReady).toBe(
      LIVE_TUNABLES.IDLE_BUFFER_TARGET,
    );

    pipeline.nextClip(); // consume the greeting first
    const played = pipeline.nextClip();
    expect(played?.jobKind).toBe("idle");
    expect(played?.loops).toBe(false);
  });

  it("keeps refilling the idle stockpile while a chain job (e.g. a fan request) is rendering", async () => {
    const queue = makeJobQueue();
    const idleRequests: ClipRequest[] = [];
    const replyDeferred = defer<ClipResult>();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        if (req.job.kind === "idle") {
          idleRequests.push(req);
          return delayed(() => chainAdvancingResult(req));
        }
        return replyDeferred.promise;
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> anchor A1
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // initial idle buffer fills against A1

    const idleRequestsBeforeReply = idleRequests.length;
    pipeline.nextClip(); // consume the greeting
    pipeline.nextClip(); // consume one idle, leaving room in the buffer target

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued(); // chain lane is now busy rendering the reply (still pending)
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

    // Idle refill must not stop just because the chain lane is busy — that's exactly what covers
    // the reply's render latency.
    expect(idleRequests.length).toBeGreaterThan(idleRequestsBeforeReply);
    expect(pipeline.getBufferStats().idleReady).toBeGreaterThan(0);

    replyDeferred.resolve(makeResult("reply", freshFrame()));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("discards a late result after dispose", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const idleDeferred = defer<ClipResult>();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        if (req.job.kind === "idle") {
          return idleDeferred.promise;
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, idle submitted

    pipeline.dispose();
    events.length = 0;
    idleDeferred.resolve(makeResult("idle", ANCHOR_0));
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toHaveLength(0);
    expect(pipeline.getBufferStats().idleReady).toBe(0);
  });
});
