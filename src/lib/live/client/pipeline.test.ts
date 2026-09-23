import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { ClipPipeline, type PipelineEvent } from "./pipeline";
import { LIVE_TUNABLES } from "@/lib/live/contract";
import type {
  ClipJob,
  ClipRequest,
  ClipResult,
  ClipSwapReport,
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

// A different look (top off), so a reply that lands here moves the anchor instead of re-seeding
// from the trusted frame of the starting look.
const strippedState: LiveState = {
  ...liveState,
  wardrobe: {
    ...liveState.wardrobe,
    top: { on: false, description: "top" },
    removedOrder: ["top"],
  },
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
// A chain job (greeting/reply/beat/checkIn) always moves to a fresh frame; an idle loop always
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
    observed: null,
    verdict: "approved",
    rejectReason: null,
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

// Same, but a chain step also strips the top: the settled look no longer has a trusted frame,
// so its end frame becomes the new anchor.
const lookChangingResult = (req: ClipRequest): ClipResult =>
  req.job.kind === "idle" || req.job.kind === "greeting"
    ? makeResult(req.job.kind, req.session.seedFrameUrl, {
        state: req.session.state,
      })
    : makeResult(req.job.kind, freshFrame(), { state: strippedState });

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

// The greeting waits for its swap like every chain clip; lands the first swap still pending so a test can move past it.
const landFirstSwap = (
  finalize: Map<
    string,
    Deferred<{ videoUrl: string; costUsd: number; report: ClipSwapReport }>
  >,
): void => {
  const [first] = finalize.values();
  first?.resolve({
    videoUrl: "https://example.com/greeting-swapped.mp4",
    costUsd: 0,
    report: { ...SWAPPED_REPORT },
  });
};

// A render that resolves via a fake timer, so instant-resolving fakes don't spin the pipeline
// forever (it resubmits idles the instant one settles).
const RENDER_DELAY_MS = 10;

const SWAPPED_REPORT: ClipSwapReport = {
  status: "swapped",
  swapMs: 6000,
  frames: 360,
  framesWithFace: 360,
  msPerFrame: 16,
  similarityBefore: 0.6,
  similarityAfter: 0.9,
  restored: true,
  reason: null,
};
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
    // Mirrors LiveDirector.abandonRequest: drops only beats owned by requestId.
    abandon: (requestId: string | null) => {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const job = queue[i];
        if (
          job?.kind === "beat" &&
          (job.beat.requestId ?? null) === requestId
        ) {
          queue.splice(i, 1);
        }
      }
    },
  };
};

const abandonDependentsFor =
  (queue: ReturnType<typeof makeJobQueue>) =>
  (job: ClipJob): void => {
    const requestId =
      job.kind === "reply"
        ? job.requestId
        : job.kind === "beat"
          ? (job.beat.requestId ?? null)
          : null;
    queue.abandon(requestId);
  };

const REPLY_JOB: ClipJob = {
  kind: "reply",
  requestId: "r1",
  text: "hi",
  channel: "chat",
  from: "fan",
  precededByIdle: false,
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
    // Nothing pre-stocks on turbo: the greeting chains to a fresh frame, so upload-seeded idles would never play.
    expect(pipeline.getBufferStats().idleInflight).toBe(0);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, promotes anchor, idles submitted
    expect(pipeline.getBufferStats().idleInflight).toBe(
      LIVE_TUNABLES.IDLE_MAX_INFLIGHT,
    );
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // idle jobs resolve
    const stats = pipeline.getBufferStats();
    expect(stats.idleReady).toBe(LIVE_TUNABLES.IDLE_BUFFER_TARGET);
    expect(stats.idleInflight).toBe(0);
    // 1 greeting + IDLE_BUFFER_TARGET idles, never more in flight than IDLE_MAX_INFLIGHT at once.
    expect(requests.length).toBe(1 + LIVE_TUNABLES.IDLE_BUFFER_TARGET);
  });

  it("never plays an idle filler before the greeting, even if the idle render finishes first", async () => {
    const greetingDeferred = defer<ClipResult>();
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      // Reference pre-stocks fillers from the upload alongside the greeting.
      backend: "reference",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        if (req.job.kind === "greeting") {
          return greetingDeferred.promise;
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // idle fillers resolve; greeting still pending

    expect(pipeline.getBufferStats().idleReady).toBeGreaterThan(0);
    expect(pipeline.nextClip()).toBeNull();

    greetingDeferred.resolve(
      chainAdvancingResult({
        job: { kind: "greeting" },
        session: snapshot,
      } as ClipRequest),
    );
    await vi.advanceTimersByTimeAsync(0);

    const first = pipeline.nextClip();
    expect(first?.jobKind).toBe("greeting");
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

  it("chains follow-up beats in order, each seeded from the previous result", async () => {
    const seeds: string[] = [];
    const queue = makeJobQueue();
    const beat: ClipJob = {
      kind: "beat",
      beat: { id: "b1", intent: { type: "act", act: "gesture" }, attempt: 0 },
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
        } else if (req.job.kind === "beat" && req.job.beat.id === "b1") {
          // A second follow-up beat (as the director's rest stage would queue), chained once only.
          queue.push({
            kind: "beat",
            beat: { id: "rest-1", intent: { type: "rest" }, attempt: 0 },
          });
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
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // rest beat

    // greeting loops on the initial anchor so the reply seeds from it too; each later step seeds
    // from the previous step's own freshly-rendered frame.
    expect(seeds).toHaveLength(4);
    expect(seeds[0]).toBe(ANCHOR_0);
    expect(seeds[1]).toBe(ANCHOR_0);
    expect(seeds[2]).not.toBe(seeds[1]);
    expect(seeds[3]).not.toBe(seeds[2]);
  });

  it("renders two fan requests enqueued back to back in strict submission order, never overlapping", async () => {
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
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting

    queue.push({ ...REPLY_JOB, requestId: "A", text: "A" });
    pipeline.onRequestEnqueued();
    // B arrives while A is still in flight, not once A has resolved.
    await vi.advanceTimersByTimeAsync(2);
    queue.push({ ...REPLY_JOB, requestId: "B", text: "B" });
    pipeline.onRequestEnqueued();

    // A must be the only chain render in flight so far; B stays queued behind it.
    expect(requests.filter((r) => r.job.kind === "reply")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS * 2);

    const replyOrder = requests
      .filter((r) => r.job.kind === "reply")
      .map((r) => (r.job.kind === "reply" ? r.job.requestId : null));
    expect(replyOrder).toEqual(["A", "B"]);
  });

  it("renders three requests submitted in the same burst (zero delay) in strict FIFO order", async () => {
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
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting

    for (const requestId of ["A", "B", "C"]) {
      queue.push({ ...REPLY_JOB, requestId, text: requestId });
      pipeline.onRequestEnqueued();
    }

    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS * 3);

    const replyOrder = requests
      .filter((r) => r.job.kind === "reply")
      .map((r) => (r.job.kind === "reply" ? r.job.requestId : null));
    expect(replyOrder).toEqual(["A", "B", "C"]);
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
    const greeting = pipeline.nextClip(); // consume the greeting
    pipeline.onClipStarted(greeting!.seedFrameUrl); // ...and confirm it actually played, at A1

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply resolves -> anchor A2
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // new idles from A2 may already be ready

    // The chained reply must come out before any A2 idle, even though A2 idles may already be
    // sitting in the ready pool.
    const first = pipeline.nextClip();
    expect(first?.jobKind).toBe("reply");
    pipeline.onClipStarted(first!.seedFrameUrl); // the reply actually plays, moving the anchor to A2
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
        return delayed(() => lookChangingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> A1, idles submitted (pending)

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply resolves onto a new look -> anchor A2

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

    // Counter isn't leaked, so fillIdleStockpile keeps refilling the dropped slots too.
    expect(attempts).toBeGreaterThanOrEqual(
      2 * LIVE_TUNABLES.IDLE_BUFFER_TARGET,
    );
    expect(events.filter((e) => e.type === "error")).toHaveLength(
      LIVE_TUNABLES.IDLE_BUFFER_TARGET,
    );
    expect(pipeline.getBufferStats().idleReady).toBe(0);
    // A leaked counter would leave this stuck at 0 forever; the fixed version keeps retrying.
    expect(pipeline.getBufferStats().idleInflight).toBeGreaterThan(0);
  });

  it("does not leak the idle inflight counter across a retried failure", async () => {
    const queue = makeJobQueue();
    // Only the first two idle submissions ever fail (one retry each); everything after succeeds.
    let idleCallCount = 0;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        if (req.job.kind !== "idle") {
          return delayed(() => chainAdvancingResult(req));
        }
        idleCallCount += 1;
        if (idleCallCount <= 2) {
          return delayed(() => {
            throw new Error("render failed");
          });
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, initial idle submitted
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // idle fails, retried
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // retry fails, slot dropped and refilled
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // refill succeeds

    const stats = pipeline.getBufferStats();
    expect(stats.idleInflight).toBe(0);
    expect(stats.idleReady).toBe(LIVE_TUNABLES.IDLE_BUFFER_TARGET);
  });

  it("keeps replenishing the idle stockpile after repeated idle failures instead of stalling", async () => {
    const queue = makeJobQueue();
    let idleCallCount = 0;
    const failingSlots = LIVE_TUNABLES.IDLE_MAX_INFLIGHT;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        if (req.job.kind !== "idle") {
          return delayed(() => chainAdvancingResult(req));
        }
        idleCallCount += 1;
        // Every idle submitted during the initial fill fails both attempts and is dropped.
        if (idleCallCount <= failingSlots * 2) {
          return delayed(() => {
            throw new Error("render failed");
          });
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, initial idles submitted
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 1s fail, retried
    // attempt 2s fail and report+drop; a leaked counter would stop fillIdleStockpile here for
    // good, but the fix means it refills immediately with slots that now succeed.
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

    const stats = pipeline.getBufferStats();
    expect(stats.idleInflight + stats.idleReady).toBeGreaterThan(0);
    expect(stats.idleInflight).toBeLessThanOrEqual(
      LIVE_TUNABLES.IDLE_MAX_INFLIGHT,
    );
  });

  it("abandons the rest of a chain on repeated failure, dropping only that request's own beats", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    // Owned by REPLY_JOB's own requestId, as the server would set it on a follow-up beat.
    const beat: ClipJob = {
      kind: "beat",
      beat: {
        id: "b1",
        intent: { type: "act", act: "gesture" },
        attempt: 0,
        requestId: REPLY_JOB.requestId,
      },
    };
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      abandonDependents: abandonDependentsFor(queue),
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
    const anchorBeforeFailure = pipeline.getCurrentAnchorFrameUrl();

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 1 fails, retries
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 2 fails, retries
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 3 fails, abandons + drops the beat

    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(pipeline.getBufferStats().chainedReady).toBe(0);
    // The queued beat was dropped rather than left to run later from a seed that never rendered.
    expect(queue.next()).toEqual({ kind: "idle" });
    // The failed clip never resolved, so it never touched chainTail/anchor.
    expect(pipeline.getCurrentAnchorFrameUrl()).toBe(anchorBeforeFailure);
  });

  it("abandons only the failed request's own beats; a different request queued behind it still runs", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const requestA: ClipJob = {
      kind: "reply",
      requestId: "A",
      text: "a",
      channel: "chat",
      from: "fan",
      precededByIdle: false,
    };
    const requestB: ClipJob = {
      kind: "reply",
      requestId: "B",
      text: "b",
      channel: "chat",
      from: "fan",
      precededByIdle: false,
    };
    const beatForA: ClipJob = {
      kind: "beat",
      beat: {
        id: "beatA",
        intent: { type: "act", act: "gesture" },
        attempt: 0,
        requestId: "A",
      },
    };
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      abandonDependents: abandonDependentsFor(queue),
      render: async (req) => {
        if (req.job.kind === "reply" && req.job.requestId === "A") {
          queue.push(beatForA); // as the director would, before A is known to have failed
          return delayed(() => {
            throw new Error("A failed");
          });
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting
    pipeline.nextClip();

    queue.push(requestA);
    queue.push(requestB); // B is already queued behind A's own beat when A fails
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // A attempt 1 fails, retries
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // A attempt 2 fails, retries
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // A attempt 3 fails, abandons A's beat
    // A failure doesn't auto-advance the chain; the next tick's pollChain() (as useLiveSession
    // does every second) is what picks B up, same as it would after any idle chain lane.
    pipeline.pollChain();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // B, untouched by the abandon, now runs

    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    const ready = events.filter(
      (e) => e.type === "clipReady" && e.lane === "chained",
    );
    expect(
      ready.some((e) => e.type === "clipReady" && e.result.jobKind === "reply"),
    ).toBe(true);
    // A's own beat was dropped; B was never touched.
    expect(queue.next()).toEqual({ kind: "idle" });
  });

  it("treats a guard-rejected chain clip as a failure: retries twice, then errors, never plays it", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    let replyRenders = 0;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        if (req.job.kind === "reply") {
          replyRenders += 1;
          return delayed(() =>
            makeResult("reply", freshFrame(), {
              verdict: "rejected",
              rejectReason: "extra person in frame",
              costUsd: 0.05,
            }),
          );
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    pipeline.nextClip();

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 1 rejected, retries
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 2 rejected, retries
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 3 rejected, abandons

    expect(replyRenders).toBe(3);
    // Every render was paid for and every one is logged as discarded; none is ever playable.
    const discarded = events.filter((e) => e.type === "clipDiscarded");
    expect(discarded).toHaveLength(3);
    expect(discarded.every((e) => e.costUsd === 0.05)).toBe(true);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("extra person in frame");
    expect(
      events.filter(
        (e) => e.type === "clipReady" && e.result.jobKind === "reply",
      ),
    ).toHaveLength(0);
    expect(pipeline.getBufferStats().chainedReady).toBe(0);
  });

  it("treats a guard-rejected idle clip as a failure and never stocks it", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        if (req.job.kind !== "idle") {
          return delayed(() => chainAdvancingResult(req));
        }
        return delayed(() =>
          makeResult("idle", req.session.seedFrameUrl, {
            verdict: "rejected",
            rejectReason: "wardrobe drifted",
          }),
        );
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // idle attempt 1 rejected, retry
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // idle attempt 2 rejected, report

    expect(pipeline.getBufferStats().idleReady).toBe(0);
    expect(
      events.filter((e) => e.type === "clipReady" && e.lane === "idle"),
    ).toHaveLength(0);
    expect(
      events.filter((e) => e.type === "error").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      events.filter((e) => e.type === "clipDiscarded").length,
    ).toBeGreaterThanOrEqual(2);
    // Rejection follows the same retry path as a thrown render, so the counter isn't leaked.
    expect(pipeline.getBufferStats().idleInflight).toBeGreaterThan(0);
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
        if (req.job.kind === "greeting") {
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

  it("bridges idles from the chain tail while the next beat renders", async () => {
    const idleRequests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const beat: ClipJob = {
      kind: "beat",
      beat: { id: "b1", intent: { type: "act", act: "gesture" }, attempt: 0 },
    };
    const beatDeferred = defer<ClipResult>();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        if (req.job.kind === "idle") {
          idleRequests.push(req);
          return delayed(() => chainAdvancingResult(req));
        }
        if (req.job.kind === "reply") {
          queue.push(beat); // as the director would, before the reply resolves
          return delayed(() => chainAdvancingResult(req));
        }
        if (req.job.kind === "beat") {
          return beatDeferred.promise; // held open so the tail stays active
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> A1
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // initial idle stockpile fills against A1
    const idleRequestsBeforeReply = idleRequests.length;

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    // reply resolves -> chain tail A2; the beat it kicks off is held pending, so bridge idles
    // should be submitted from the tail alongside it rather than waiting for the beat to finish.
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

    const bridgeRequests = idleRequests.slice(idleRequestsBeforeReply);
    expect(bridgeRequests.length).toBeGreaterThan(0);
    const tailSeed = bridgeRequests[0]?.session.seedFrameUrl;
    expect(tailSeed).not.toBe(ANCHOR_0);
    for (const req of bridgeRequests) {
      expect(req.job.kind).toBe("idle");
      expect(req.session.seedFrameUrl).toBe(tailSeed);
    }
  });

  it("returns a bridge idle from nextClip instead of null while the next beat still renders", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const beat: ClipJob = {
      kind: "beat",
      beat: { id: "b1", intent: { type: "act", act: "gesture" }, attempt: 0 },
    };
    const beatDeferred = defer<ClipResult>();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        if (req.job.kind === "reply") {
          queue.push(beat);
          return delayed(() => chainAdvancingResult(req));
        }
        if (req.job.kind === "beat") {
          return beatDeferred.promise;
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> A1
    pipeline.nextClip(); // consume the greeting; displayAnchor = A1

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply resolves -> tail A2; beat pending; bridge idles submitted from A2
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // bridge idles resolve

    const reply = pipeline.nextClip();
    expect(reply?.jobKind).toBe("reply");

    // Before the fix, no idle was ever seeded from the tail, so this would be null (a still-frame
    // hold) until the beat's own render finished.
    const bridgeIdle = pipeline.nextClip();
    expect(bridgeIdle).not.toBeNull();
    expect(bridgeIdle?.jobKind).toBe("idle");
    expect(events.some((e) => e.type === "bufferEmpty")).toBe(false);
  });

  it("keeps old-anchor idles playable without counting them toward the tail's buffer target", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const beat: ClipJob = {
      kind: "beat",
      beat: { id: "b1", intent: { type: "act", act: "gesture" }, attempt: 0 },
    };
    const beatDeferred = defer<ClipResult>();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        if (req.job.kind === "reply") {
          queue.push(beat);
          return delayed(() => chainAdvancingResult(req));
        }
        if (req.job.kind === "beat") {
          return beatDeferred.promise;
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> A1
    pipeline.nextClip(); // consume greeting; displayAnchor = A1
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // initial idles (seeded A1) ready
    expect(pipeline.getBufferStats().idleReady).toBe(
      LIVE_TUNABLES.IDLE_BUFFER_TARGET,
    );

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    // reply resolves -> tail A2; the A1 idles are still sitting in the pool, unmatched by the new
    // target, so a fresh round of bridge idles is submitted for A2 alongside them.
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

    expect(events.filter((e) => e.type === "clipDiscarded")).toHaveLength(0);
    expect(pipeline.getBufferStats().idleReady).toBe(
      LIVE_TUNABLES.IDLE_BUFFER_TARGET,
    );
    expect(pipeline.getBufferStats().idleInflight).toBe(
      LIVE_TUNABLES.IDLE_MAX_INFLIGHT,
    );

    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // bridge idles (seeded A2) resolve too

    // The pool now holds both the untouched A1 stock and the new A2 stock: old stock was never
    // evicted just because it stopped matching the idle lane's current target.
    expect(pipeline.getBufferStats().idleReady).toBe(
      LIVE_TUNABLES.IDLE_BUFFER_TARGET * 2,
    );
  });

  it("counts tail-seeded bridge idles as current-anchor stock once the tail is promoted", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => delayed(() => chainAdvancingResult(req)),
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> A1
    const greeting = pipeline.nextClip(); // consume greeting
    pipeline.onClipStarted(greeting!.seedFrameUrl); // ...playing it; displayAnchor = A1
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // initial idles from A1 ready

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    // reply resolves; the queue is empty so the tail is promoted to anchor A2 in the same tick,
    // and the bridge idles it kicked off keep rendering against what is now the current anchor.
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // those bridge idles resolve

    expect(events.filter((e) => e.type === "clipDiscarded")).toHaveLength(0);

    const reply = pipeline.nextClip();
    expect(reply?.jobKind).toBe("reply");
    pipeline.onClipStarted(reply!.seedFrameUrl); // the reply plays, moving displayAnchor to A2
    const bridgeIdle = pipeline.nextClip();
    expect(bridgeIdle?.jobKind).toBe("idle");
    expect(bridgeIdle?.seedFrameUrl).toBe(reply?.seedFrameUrl);
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

  it("stops dispatching new render jobs once cumulative cost reaches SESSION_COST_CAP_USD", async () => {
    const events: PipelineEvent[] = [];
    const renderCalls: ClipRequest[] = [];
    const queue = makeJobQueue();
    // Each clip costs enough that the greeting alone (plus its initial idle stockpile) crosses
    // the cap, so no further job should ever be dispatched after that first batch settles.
    const bigCost = LIVE_TUNABLES.SESSION_COST_CAP_USD;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        renderCalls.push(req);
        return delayed(() =>
          makeResult(
            req.job.kind === "idle" ? "idle" : "greeting",
            req.job.kind === "idle" ? req.session.seedFrameUrl : freshFrame(),
            { costUsd: bigCost },
          ),
        );
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting settles, cap reached on its cost alone

    expect(events.some((e) => e.type === "costCapReached")).toBe(true);
    const callsAtCap = renderCalls.length;

    // A new fan request must be refused, not queued for later render.
    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

    expect(renderCalls.length).toBe(callsAtCap);
    expect(renderCalls.some((r) => r.job.kind === "reply")).toBe(false);
    expect(events.filter((e) => e.type === "costCapReached")).toHaveLength(1);
  });

  it("dispatches a bridge idle for the chain tail the instant the chain clip settles approved, before any pickNext/nextClip call", async () => {
    const idleRequests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        if (req.job.kind === "idle") {
          idleRequests.push(req);
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting settles -> A1
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // initial idles against A1 settle too

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    const idleRequestsBeforeSettle = idleRequests.length;

    // Advance only far enough for the reply's render to settle; no nextClip()/pickNext() call has
    // happened for this reply at all, so any idle for its tail can only have come from settle time.
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

    const bridgeRequests = idleRequests.slice(idleRequestsBeforeSettle);
    expect(bridgeRequests.length).toBeGreaterThan(0);
    expect(bridgeRequests[0]?.session.seedFrameUrl).not.toBe(ANCHOR_0);
  });

  it("chains the next pull from the last handed-out clip, not the displayed frame (no scene jump on preload)", async () => {
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => delayed(() => chainAdvancingResult(req)),
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting -> A0 (loops)
    const greeting = pipeline.nextClip();
    pipeline.onClipStarted(greeting!.seedFrameUrl);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // A0 idles stocked

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply -> A2
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // bridge idles from A2 stocked

    // Preload pull while the greeting is still on screen: the clip behind the reply must continue from the reply's end frame.
    const reply = pipeline.nextClip();
    expect(reply?.jobKind).toBe("reply");
    const behindReply = pipeline.nextClip();
    expect(behindReply).not.toBeNull();
    expect(behindReply?.seedFrameUrl).toBe(reply?.seedFrameUrl);
    expect(behindReply?.seedFrameUrl).not.toBe(ANCHOR_0);
  });

  it("upscales a settled chain job's seed in the background, without delaying clipReady, and feeds it to the next chain job", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const upscaleDeferreds = new Map<
      string,
      Deferred<{ url: string | null; costUsd: number }>
    >();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => lookChangingResult(req));
      },
      upscaleSeed: async (frameUrl) => {
        const d = defer<{ url: string | null; costUsd: number }>();
        upscaleDeferreds.set(frameUrl, d);
        return d.promise;
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting settles; clipReady already fired
    expect(pipeline.nextClip()).not.toBeNull(); // clipReady wasn't blocked on the pending upscale

    now += LIVE_TUNABLES.UPSCALE_INTERVAL_MS; // past the cadence gate, so this settle's upscale fires too
    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply settles onto a fresh frame
    const reply = pipeline.nextClip();
    const rawReplySeed = reply!.seedFrameUrl;

    const upscaled = "https://example.com/upscaled.jpg";
    upscaleDeferreds
      .get(rawReplySeed)
      ?.resolve({ url: upscaled, costUsd: 0.03 });
    // Resolving upscaleSeed's own promise is itself a microtask hop before its .then() runs.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    queue.push({ ...REPLY_JOB, requestId: "r2" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    pipeline.nextClip();

    const secondReplyRequest = requests.find(
      (r) => r.job.kind === "reply" && r.job.requestId === "r2",
    );
    expect(secondReplyRequest?.session.seedFrameUrl).toBe(upscaled);
  });

  it("does not upscale again within UPSCALE_INTERVAL_MS of the last upscale", async () => {
    const upscaleSeed = vi.fn(
      async (): Promise<{ url: string | null; costUsd: number }> => ({
        url: "https://example.com/upscaled.jpg",
        costUsd: 0.03,
      }),
    );
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => delayed(() => chainAdvancingResult(req)),
      upscaleSeed,
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(upscaleSeed).toHaveBeenCalledTimes(1);

    now += LIVE_TUNABLES.UPSCALE_INTERVAL_MS - 1; // just short of the cadence
    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(upscaleSeed).toHaveBeenCalledTimes(1);

    now += 1; // now at the cadence
    queue.push({ ...REPLY_JOB, requestId: "r2" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(upscaleSeed).toHaveBeenCalledTimes(2);
  });

  it("only sets useIdentityReference on a chain job's first attempt, and only when the gate says it's due", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    let due = false;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
      needsIdentityReference: () => due,
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(requests[0]?.useIdentityReference).toBe(false);

    due = true;
    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    const replyRequest = requests.find((req) => req.job.kind === "reply");
    expect(replyRequest?.useIdentityReference).toBe(true);
  });

  it("passes useIdentityReference through for every chain job the director's gate reports due, e.g. once a chain-clip-count limit is reached", async () => {
    // Stands in for LiveDirector's chain-clip-count trigger: due every Nth chain job.
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    let chainJobsSinceDue = 0;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
      needsIdentityReference: () => {
        chainJobsSinceDue += 1;
        if (chainJobsSinceDue >= 2) {
          chainJobsSinceDue = 0;
          return true;
        }
        return false;
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting: 1st chain job, not due

    queue.push({ ...REPLY_JOB, requestId: "r1" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply: 2nd chain job, due

    const replies = requests.filter((r) => r.job.kind === "reply");
    expect(replies[0]?.useIdentityReference).toBe(true);
  });

  it("a stale upscale result never clobbers a chainTail that already moved past it", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const upscaleDeferreds = new Map<
      string,
      Deferred<{ url: string | null; costUsd: number }>
    >();
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => lookChangingResult(req));
      },
      upscaleSeed: async (frameUrl) => {
        const d = defer<{ url: string | null; costUsd: number }>();
        upscaleDeferreds.set(frameUrl, d);
        return d.promise;
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting settles, upscale kicked off on ANCHOR_0
    pipeline.nextClip(); // consume the greeting so the reply below is what nextClip() returns next

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply settles: chainTail moves past ANCHOR_0
    const reply = pipeline.nextClip();
    const replySeed = reply!.seedFrameUrl;

    // The greeting's upscale (keyed by ANCHOR_0) finally resolves, long after chainTail moved on.
    upscaleDeferreds.get(ANCHOR_0)?.resolve({
      url: "https://example.com/stale-upscaled.jpg",
      costUsd: 0.03,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    queue.push({ ...REPLY_JOB, requestId: "r2" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    pipeline.nextClip();

    const secondReplyRequest = requests.find(
      (r) => r.job.kind === "reply" && r.job.requestId === "r2",
    );
    expect(secondReplyRequest?.session.seedFrameUrl).toBe(replySeed);
  });

  it("re-seeds from the trusted frame when a plan ends on a look that already has one, instead of chaining off the drifted tail (reference backend)", async () => {
    const requests: ClipRequest[] = [];
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "reference",
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    pipeline.nextClip();

    queue.push({ ...REPLY_JOB, requestId: "r1" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply ends on a fresh frame, same look
    const reply = pipeline.nextClip();
    expect(reply?.seedFrameUrl).not.toBe(ANCHOR_0);

    const promotions = events.filter((e) => e.type === "anchorChanged");
    expect(promotions.at(-1)?.frameUrl).toBe(ANCHOR_0);

    queue.push({ ...REPLY_JOB, requestId: "r2" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    const secondReplyRequest = requests.find(
      (r) => r.job.kind === "reply" && r.job.requestId === "r2",
    );
    expect(secondReplyRequest?.session.seedFrameUrl).toBe(ANCHOR_0);
  });

  it("keeps trusted-frame idles playable after the drifted reply clip, and prefers a tail-seeded bridge idle when one exists", async () => {
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "reference",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => delayed(() => chainAdvancingResult(req)),
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    const greeting = pipeline.nextClip();
    pipeline.onClipStarted(greeting!.seedFrameUrl);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // ANCHOR_0 idles stocked

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply settles; bridge idles from its tail submitted
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // bridge idles ready

    const reply = pipeline.nextClip();
    expect(reply?.jobKind).toBe("reply");
    pipeline.onClipStarted(reply!.seedFrameUrl);

    const bridge = pipeline.nextClip();
    expect(bridge?.jobKind).toBe("idle");
    expect(bridge?.seedFrameUrl).toBe(reply?.seedFrameUrl);

    // Drain every fresh idle: the ANCHOR_0 stock must be reachable behind the drifted tail, never stranded. Stops at the first deck replay, which never runs dry.
    const seeds = new Set<string>();
    const played = new Set<string>();
    for (let clip = pipeline.nextClip(); clip; clip = pipeline.nextClip()) {
      if (played.has(clip.clipId)) {
        break;
      }
      played.add(clip.clipId);
      expect(clip.jobKind).toBe("idle");
      seeds.add(clip.seedFrameUrl);
    }
    expect(seeds.has(ANCHOR_0)).toBe(true);
  });

  it.each([
    ["swap", "swap"],
    ["reference", "turbo"],
    ["turbo", "turbo"],
  ] as const)(
    "renders idle fillers on %s mode with the %s backend",
    async (backend, idleBackend) => {
      const requests: ClipRequest[] = [];
      const queue = makeJobQueue();
      const pipeline = trackedPipeline({
        backend,
        now: nowFn,
        onEvent: () => {},
        render: async (req) => {
          requests.push(req);
          return delayed(() => chainAdvancingResult(req));
        },
      });
      pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
      const idle = requests.find((r) => r.job.kind === "idle");
      expect(idle?.backend).toBe(idleBackend);
    },
  );

  it("never re-seeds on turbo: the next plan chains from the drifted tail rather than jumping back to the upload", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "turbo",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    pipeline.nextClip();

    queue.push({ ...REPLY_JOB, requestId: "r1" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    const replySeed = pipeline.nextClip()!.seedFrameUrl;
    expect(replySeed).not.toBe(ANCHOR_0);

    queue.push({ ...REPLY_JOB, requestId: "r2" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    const secondReplyRequest = requests.find(
      (r) => r.job.kind === "reply" && r.job.requestId === "r2",
    );
    expect(secondReplyRequest?.session.seedFrameUrl).toBe(replySeed);
  });

  it("registers the first settled frame of a new look as its trusted seed and re-seeds from it on the next visit", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "reference",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => lookChangingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    pipeline.nextClip();

    queue.push({ ...REPLY_JOB, requestId: "r1" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // first stripped frame S1 becomes the anchor
    const firstStripped = pipeline.nextClip()!.seedFrameUrl;

    queue.push({ ...REPLY_JOB, requestId: "r2" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // seeds from S1, ends on S2 (same stripped look)
    const secondStripped = pipeline.nextClip()!.seedFrameUrl;
    expect(secondStripped).not.toBe(firstStripped);

    queue.push({ ...REPLY_JOB, requestId: "r3" });
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    const seedsByRequest = Object.fromEntries(
      requests
        .filter((r) => r.job.kind === "reply")
        .map((r) => [
          r.job.kind === "reply" ? r.job.requestId : "",
          r.session.seedFrameUrl,
        ]),
    );
    expect(seedsByRequest.r1).toBe(ANCHOR_0);
    expect(seedsByRequest.r2).toBe(firstStripped);
    expect(seedsByRequest.r3).toBe(firstStripped);
  });

  it("swap mode sends the session's persona id on every chain and idle render", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "swap",
      personaId: "synth-persona-01",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS * 2);
    expect(requests.map((req) => req.job.kind)).toContain("idle");
    expect(requests.every((req) => req.personaId === "synth-persona-01")).toBe(
      true,
    );
  });

  it("swap mode sends the Hand mask on every chain and idle render", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "swap",
      personaId: "synth-persona-01",
      swapHandMask: true,
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS * 2);
    expect(requests.map((req) => req.job.kind)).toContain("idle");
    expect(requests.every((req) => req.swapHandMask === true)).toBe(true);
  });

  it("swap mode keeps two idles in flight and two ready, since a filler takes longer to make than it plays", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, fillers submitted from its tail
    // The spare in-flight slot is for a bridge idle later, not for a third filler from the same anchor.
    expect(pipeline.getBufferStats().idleInflight).toBe(
      LIVE_TUNABLES.SWAP_IDLE_BUFFER_TARGET,
    );
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    const stats = pipeline.getBufferStats();
    expect(stats.idleReady).toBe(LIVE_TUNABLES.SWAP_IDLE_BUFFER_TARGET);
    expect(stats.idleInflight).toBe(0);
    expect(requests.length).toBe(1 + LIVE_TUNABLES.SWAP_IDLE_BUFFER_TARGET);
  });

  it("swap mode holds new fillers while a request renders, so the reply's swap does not queue behind them, and resumes once it lands", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const replyDeferred = defer<ClipResult>();
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        if (req.job.kind === "reply") {
          return replyDeferred.promise;
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, fillers submitted
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // fillers ready
    expect(pipeline.getBufferStats().idleReady).toBe(
      LIVE_TUNABLES.SWAP_IDLE_BUFFER_TARGET,
    );

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    const replyRequest = requests.find((r) => r.job.kind === "reply");
    expect(replyRequest).toBeDefined();
    pipeline.nextClip(); // greeting
    pipeline.nextClip(); // one filler leaves the shelf: normally a refill
    expect(pipeline.getBufferStats().idleInflight).toBe(0);

    replyDeferred.resolve(chainAdvancingResult(replyRequest as ClipRequest));
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.getBufferStats().idleInflight).toBeGreaterThan(0);
  });

  it("two-phase swap: the greeting waits for its own swap, then plays swapped", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const finalize = new Map<
      string,
      Deferred<{
        videoUrl: string;
        costUsd: number;
        report: ClipResult["swap"] & object;
      }>
    >();
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: (event) => events.push(event),
      render: async (req) =>
        delayed(() => ({
          ...chainAdvancingResult(req),
          swap: {
            status: "pending" as const,
            swapMs: 0,
            frames: 0,
            framesWithFace: 0,
            msPerFrame: 0,
            similarityBefore: null,
            similarityAfter: null,
            restored: false,
            reason: null,
          },
        })),
      finalizeSwap: (result) => {
        const deferred = defer<{
          videoUrl: string;
          costUsd: number;
          report: ClipResult["swap"] & object;
        }>();
        finalize.set(result.clipId, deferred);
        return deferred.promise;
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting rendered: pending swap
    // Unswapped it showed the raw render's face for 15 s, then jumped to the persona at the first cut.
    expect(pipeline.nextClip()).toBeNull();
    expect(finalize.size).toBe(1);
    landFirstSwap(finalize);
    await vi.advanceTimersByTimeAsync(0);
    const played = pipeline.nextClip();
    expect(played?.jobKind).toBe("greeting");
    expect(played?.videoUrl).toBe("https://example.com/greeting-swapped.mp4");
    expect(played?.swap?.status).toBe("swapped");
  });

  it("two-phase swap: a greeting whose swap fails plays unswapped instead of holding the join", async () => {
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: pendingSwapRender,
      finalizeSwap: () =>
        Promise.reject(new Error("Swap service responded 503")),
    });
    pipeline.start({ kind: "greeting" }, () => snapshot, makeJobQueue().next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    await vi.advanceTimersByTimeAsync(0);
    const played = pipeline.nextClip();
    expect(played?.jobKind).toBe("greeting");
    expect(played?.videoUrl).toMatch(/example\.com\/\d+\.mp4$/);
    expect(played?.swap?.status).toBe("failed");
  });

  it("two-phase swap: a chained clip after the greeting plays only once its swap lands, and fillers wait for it", async () => {
    const requests: ClipRequest[] = [];
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const finalize = new Map<
      string,
      Deferred<{
        videoUrl: string;
        lastFrameUrl?: string;
        costUsd: number;
        report: ClipResult["swap"] & object;
      }>
    >();
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: (event) => events.push(event),
      render: async (req) => {
        requests.push(req);
        return delayed(() => ({
          ...chainAdvancingResult(req),
          swap: {
            status: "pending" as const,
            swapMs: 0,
            frames: 0,
            framesWithFace: 0,
            msPerFrame: 0,
            similarityBefore: null,
            similarityAfter: null,
            restored: false,
            reason: null,
          },
        }));
      },
      finalizeSwap: (result) => {
        const deferred = defer<{
          videoUrl: string;
          lastFrameUrl?: string;
          costUsd: number;
          report: ClipResult["swap"] & object;
        }>();
        finalize.set(result.clipId, deferred);
        return deferred.promise;
      },
    });

    queue.push(REPLY_JOB);
    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting rendered, its swap pending
    // The reply already renders from the greeting's tail while the greeting's own swap is still pending.
    const reply = requests.find((r) => r.job.kind === "reply");
    expect(reply).toBeDefined();
    expect(reply?.session.seedFrameUrl).toBe(snapshot.seedFrameUrl);
    landFirstSwap(finalize);
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.nextClip()?.jobKind).toBe("greeting");

    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply rendered: pending swap, tail is the seed
    const replyId = events.find(
      (e) => e.type === "clipRendered" && e.result.jobKind === "reply",
    );
    expect(replyId).toBeDefined();
    // Fillers hold while a chain swap is pending and the shelf is not bare.
    expect(pipeline.nextClip()).toBeNull();
    expect(
      events.some(
        (e) => e.type === "clipReady" && e.result.jobKind === "reply",
      ),
    ).toBe(false);

    const pendingReplyId =
      replyId && (replyId as { result: ClipResult }).result.clipId;
    finalize.get(pendingReplyId as string)?.resolve({
      videoUrl: "https://example.com/reply-swapped.mp4",
      costUsd: 0.004,
      report: {
        status: "swapped",
        swapMs: 6000,
        frames: 360,
        framesWithFace: 360,
        msPerFrame: 16,
        similarityBefore: 0.6,
        similarityAfter: 0.9,
        restored: true,
        reason: null,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const played = pipeline.nextClip();
    expect(played?.jobKind).toBe("reply");
    expect(played?.videoUrl).toBe("https://example.com/reply-swapped.mp4");
    expect(played?.swap?.status).toBe("swapped");
  });

  it("two-phase swap: a failed clip swap still plays, unswapped, with a failed report", async () => {
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) =>
        delayed(() => ({
          ...chainAdvancingResult(req),
          swap: {
            status: "pending" as const,
            swapMs: 0,
            frames: 0,
            framesWithFace: 0,
            msPerFrame: 0,
            similarityBefore: null,
            similarityAfter: null,
            restored: false,
            reason: null,
          },
        })),
      finalizeSwap: (result) =>
        result.jobKind === "reply"
          ? Promise.reject(new Error("Swap service responded 503"))
          : Promise.resolve({
              videoUrl: result.videoUrl,
              costUsd: 0,
              report: { ...SWAPPED_REPORT },
            }),
    });
    const queueWithReply = queue;
    queueWithReply.push(REPLY_JOB);
    pipeline.start({ kind: "greeting" }, () => snapshot, queueWithReply.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting rendered and swapped
    pipeline.nextClip(); // greeting leaves the shelf
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply rendered
    await vi.advanceTimersByTimeAsync(0);
    const played = pipeline.nextClip();
    expect(played?.jobKind).toBe("reply");
    expect(played?.videoUrl).toMatch(/example\.com\/\d+\.mp4$/);
    expect(played?.swap?.status).toBe("failed");
    expect(played?.swap?.reason).toMatch(/503/);
  });

  const pendingSwapRender = async (
    req: Parameters<typeof chainAdvancingResult>[0],
  ) =>
    delayed(() => ({
      ...chainAdvancingResult(req),
      swap: {
        status: "pending" as const,
        swapMs: 0,
        frames: 0,
        framesWithFace: 0,
        msPerFrame: 0,
        similarityBefore: null,
        similarityAfter: null,
        restored: false,
        reason: null,
      },
    }));

  it("two-phase swap: an idle whose swap fails once is dropped and restocked, never played with the raw face", async () => {
    const events: PipelineEvent[] = [];
    let calls = 0;
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: (event) => events.push(event),
      render: pendingSwapRender,
      finalizeSwap: (result) => {
        calls += result.jobKind === "idle" ? 1 : 0;
        return result.jobKind === "idle" && calls === 1
          ? Promise.reject(new Error("Swap service responded 500"))
          : Promise.resolve({
              videoUrl: result.videoUrl,
              costUsd: 0,
              report: { ...result.swap!, status: "swapped" as const },
            });
      },
    });
    pipeline.start({ kind: "greeting" }, () => snapshot, makeJobQueue().next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting swapped
    pipeline.nextClip();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS * 3);
    const discarded = events.filter(
      (event) =>
        event.type === "clipDiscarded" && event.result.jobKind === "idle",
    );
    expect(discarded).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "clipReady" &&
          event.result.jobKind === "idle" &&
          event.result.swap?.status === "failed",
      ),
    ).toBe(false);
  });

  it("two-phase swap: when every swap fails, idles still play unswapped instead of starving the player", async () => {
    const events: PipelineEvent[] = [];
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: (event) => events.push(event),
      render: pendingSwapRender,
      finalizeSwap: () =>
        Promise.reject(new Error("Swap service responded 404")),
    });
    pipeline.start({ kind: "greeting" }, () => snapshot, makeJobQueue().next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    // The greeting plays unswapped, and its failed swap already counts, so no idle is dropped.
    expect(pipeline.nextClip()?.swap?.status).toBe("failed");
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS * 3);
    expect(
      events.filter(
        (event) =>
          event.type === "clipDiscarded" && event.result.jobKind === "idle",
      ),
    ).toHaveLength(0);
    expect(pipeline.nextClip()?.jobKind).toBe("idle");
  });

  it("two-phase swap: an idle anchored on the cursor covers a reply still swapping instead of a hold, and cut-in waits for the reply to be playable", async () => {
    const events: PipelineEvent[] = [];
    const queue = makeJobQueue();
    const finalize = new Map<
      string,
      Deferred<{
        videoUrl: string;
        costUsd: number;
        report: ClipResult["swap"] & object;
      }>
    >();
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: (event) => events.push(event),
      render: async (req) =>
        delayed(() => ({
          ...chainAdvancingResult(req),
          swap: {
            status: "pending" as const,
            swapMs: 0,
            frames: 0,
            framesWithFace: 0,
            msPerFrame: 0,
            similarityBefore: null,
            similarityAfter: null,
            restored: false,
            reason: null,
          },
        })),
      finalizeSwap: (result) => {
        const deferred = defer<{
          videoUrl: string;
          costUsd: number;
          report: ClipResult["swap"] & object;
        }>();
        finalize.set(result.clipId, deferred);
        return deferred.promise;
      },
    });
    const swappedReport = {
      status: "swapped" as const,
      swapMs: 6000,
      frames: 240,
      framesWithFace: 240,
      msPerFrame: 25,
      similarityBefore: 0.6,
      similarityAfter: 0.9,
      restored: true,
      reason: null,
    };

    queue.push(REPLY_JOB);
    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting rendered
    landFirstSwap(finalize);
    await vi.advanceTimersByTimeAsync(0);
    pipeline.nextClip(); // greeting plays; bridge idles render from its tail alongside the reply
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply and idles rendered, all swaps pending
    const rendered = (kind: string) =>
      events.filter(
        (e): e is Extract<PipelineEvent, { type: "clipRendered" }> =>
          e.type === "clipRendered" && e.result.jobKind === kind,
      );
    const replyId = rendered("reply")[0]?.result.clipId;
    const idleId = rendered("idle")[0]?.result.clipId;
    expect(replyId).toBeDefined();
    expect(idleId).toBeDefined();
    // Nothing has landed: a hold is all that is left.
    expect(pipeline.nextClip()).toBeNull();
    expect(pipeline.hasChainedReady()).toBe(false);

    finalize.get(idleId as string)?.resolve({
      videoUrl: "https://example.com/idle-swapped.mp4",
      costUsd: 0.003,
      report: swappedReport,
    });
    await vi.advanceTimersByTimeAsync(0);
    // The idle loops back to the frame the reply starts from, so it covers the wait; the reply is still not a cut-in target.
    expect(pipeline.hasChainedReady()).toBe(false);
    expect(pipeline.nextClip()?.clipId).toBe(idleId);

    finalize.get(replyId as string)?.resolve({
      videoUrl: "https://example.com/reply-swapped.mp4",
      costUsd: 0.004,
      report: swappedReport,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.hasChainedReady()).toBe(true);
    expect(pipeline.nextClip()?.clipId).toBe(replyId);
  });

  it("two-phase swap: the clip behind a reply swaps alongside it, and still plays only after the reply", async () => {
    const queue = makeJobQueue();
    const finalize = new Map<
      string,
      Deferred<{
        videoUrl: string;
        costUsd: number;
        report: ClipResult["swap"] & object;
      }>
    >();
    const finalizeOrder: string[] = [];
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) =>
        delayed(() => ({
          ...chainAdvancingResult(req),
          swap: {
            status: "pending" as const,
            swapMs: 0,
            frames: 0,
            framesWithFace: 0,
            msPerFrame: 0,
            similarityBefore: null,
            similarityAfter: null,
            restored: false,
            reason: null,
          },
        })),
      finalizeSwap: (result) => {
        // Fillers and the greeting land at once so they hold no slot; only the chain lane behind them is under test.
        if (result.jobKind === "idle" || result.jobKind === "greeting") {
          return Promise.resolve({
            videoUrl: `${result.videoUrl}#swapped`,
            costUsd: 0,
            report: { ...SWAPPED_REPORT },
          });
        }
        finalizeOrder.push(result.jobKind);
        const deferred = defer<{
          videoUrl: string;
          costUsd: number;
          report: ClipResult["swap"] & object;
        }>();
        finalize.set(result.jobKind, deferred);
        return deferred.promise;
      },
    });

    queue.push(REPLY_JOB);
    queue.push({ kind: "checkIn", channel: "chat" });
    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting rendered and swapped
    pipeline.nextClip();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply rendered: its swap starts
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // checkIn rendered behind it: it swaps alongside
    expect(LIVE_TUNABLES.SWAP_CHAIN_MAX_CONCURRENT).toBe(2);
    expect(finalizeOrder).toEqual(["reply", "checkIn"]);

    // The checkIn landing first must not jump the reply still swapping.
    finalize.get("checkIn")?.resolve({
      videoUrl: "https://example.com/checkin-swapped.mp4",
      costUsd: 0.004,
      report: { ...SWAPPED_REPORT },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.hasChainedReady()).toBe(false);

    finalize.get("reply")?.resolve({
      videoUrl: "https://example.com/reply-swapped.mp4",
      costUsd: 0.004,
      report: {
        status: "swapped",
        swapMs: 6000,
        frames: 360,
        framesWithFace: 360,
        msPerFrame: 16,
        similarityBefore: 0.6,
        similarityAfter: 0.9,
        restored: true,
        reason: null,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.nextClip()?.jobKind).toBe("reply");
    expect(pipeline.nextClip()?.jobKind).toBe("checkIn");
  });

  it("two-phase swap: every chain clip seeds from the tail of the clip played before it, and every idle between them from that same tail, even when concurrent swaps land out of order", async () => {
    const queue = makeJobQueue();
    const requestSeed = new Map<string, string>();
    const pendingSwaps: Deferred<{
      videoUrl: string;
      costUsd: number;
      report: ClipSwapReport;
    }>[] = [];
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) =>
        delayed(() => {
          const result = {
            ...chainAdvancingResult(req),
            swap: { ...SWAPPED_REPORT, status: "pending" as const },
          };
          requestSeed.set(result.clipId, req.session.seedFrameUrl);
          return result;
        }),
      finalizeSwap: (result) => {
        if (result.jobKind === "idle" || result.jobKind === "greeting") {
          return Promise.resolve({
            videoUrl: `${result.videoUrl}#swapped`,
            costUsd: 0,
            report: { ...SWAPPED_REPORT },
          });
        }
        const deferred = defer<{
          videoUrl: string;
          costUsd: number;
          report: ClipSwapReport;
        }>();
        pendingSwaps.push(deferred);
        return deferred.promise;
      },
    });

    queue.push(REPLY_JOB);
    queue.push({ kind: "checkIn", channel: "chat" });
    queue.push({ ...REPLY_JOB, requestId: "r2" });
    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    const played: ClipResult[] = [];
    for (let step = 0; step < 16; step += 1) {
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
      // Two chain swaps are held in flight, then land later one first, the order SWAP_CHAIN_MAX_CONCURRENT allows.
      const landing =
        pendingSwaps.length >= 2 || step >= 8 ? pendingSwaps.splice(0) : [];
      for (const deferred of landing.reverse()) {
        deferred.resolve({
          videoUrl: "https://example.com/swapped.mp4",
          costUsd: 0,
          report: { ...SWAPPED_REPORT },
        });
      }
      await vi.advanceTimersByTimeAsync(0);
      const next = pipeline.nextClip();
      if (next) {
        played.push(next);
      }
    }

    const chain = played.filter((clip) => clip.jobKind !== "idle");
    expect(chain.map((clip) => clip.jobKind)).toEqual([
      "greeting",
      "reply",
      "checkIn",
      "reply",
    ]);
    let tail = "";
    for (const clip of played) {
      if (clip.jobKind === "greeting") {
        tail = clip.seedFrameUrl;
        continue;
      }
      expect(requestSeed.get(clip.clipId)).toBe(tail);
      if (clip.jobKind !== "idle") {
        tail = clip.seedFrameUrl;
      }
    }
  });

  it("two-phase swap: fillers share SWAP_MAX_CONCURRENT minus one slot, the chain keeps its own, and a queued filler starts when one lands", async () => {
    const queue = makeJobQueue();
    const started: string[] = [];
    const finalize = new Map<
      string,
      Deferred<{
        videoUrl: string;
        costUsd: number;
        report: ClipResult["swap"] & object;
      }>
    >();
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) =>
        delayed(() => ({
          ...chainAdvancingResult(req),
          swap: {
            status: "pending" as const,
            swapMs: 0,
            frames: 0,
            framesWithFace: 0,
            msPerFrame: 0,
            similarityBefore: null,
            similarityAfter: null,
            restored: false,
            reason: null,
          },
        })),
      finalizeSwap: (result) => {
        // The greeting lands at once; only the slots after it are under test.
        if (result.jobKind === "greeting") {
          return Promise.resolve({
            videoUrl: result.videoUrl,
            costUsd: 0,
            report: { ...SWAPPED_REPORT },
          });
        }
        started.push(result.jobKind);
        const deferred = defer<{
          videoUrl: string;
          costUsd: number;
          report: ClipResult["swap"] & object;
        }>();
        finalize.set(result.clipId, deferred);
        return deferred.promise;
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting rendered, two fillers submitted
    pipeline.nextClip();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // both fillers rendered: they take the two filler slots
    expect(started).toEqual(["idle", "idle"]);
    expect(LIVE_TUNABLES.SWAP_MAX_CONCURRENT).toBe(3);

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply rendered: its reserved slot is free, it does not wait behind the fillers
    expect(started).toEqual(["idle", "idle", "reply"]);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // the reply's bridge filler rendered: both filler slots are taken, so it queues
    expect(started).toEqual(["idle", "idle", "reply"]);

    const [firstIdle] = [...finalize.entries()];
    firstIdle?.[1].resolve({
      videoUrl: "https://example.com/idle-swapped.mp4",
      costUsd: 0.003,
      report: {
        status: "swapped",
        swapMs: 8000,
        frames: 240,
        framesWithFace: 240,
        msPerFrame: 33,
        similarityBefore: 0.4,
        similarityAfter: 0.9,
        restored: true,
        reason: null,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["idle", "idle", "reply", "idle"]);
  });

  it("two-phase swap: a queued filler whose anchor playback has moved past is dropped instead of swapped", async () => {
    const queue = makeJobQueue();
    const events: PipelineEvent[] = [];
    const started: ClipResult[] = [];
    const finalize = new Map<
      string,
      Deferred<{
        videoUrl: string;
        costUsd: number;
        report: ClipResult["swap"] & object;
      }>
    >();
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: (event) => events.push(event),
      render: async (req) =>
        delayed(() => ({
          ...chainAdvancingResult(req),
          swap: { ...SWAPPED_REPORT, status: "pending" as const },
        })),
      finalizeSwap: (result) => {
        // The greeting lands at once; only the fillers and chain behind it are under test.
        if (result.jobKind === "greeting") {
          return Promise.resolve({
            videoUrl: result.videoUrl,
            costUsd: 0,
            report: { ...SWAPPED_REPORT },
          });
        }
        started.push(result);
        const deferred = defer<{
          videoUrl: string;
          costUsd: number;
          report: ClipResult["swap"] & object;
        }>();
        finalize.set(result.clipId, deferred);
        return deferred.promise;
      },
    });
    const land = async (clip: ClipResult | undefined) => {
      finalize.get(clip?.clipId ?? "")?.resolve({
        videoUrl: `${clip?.videoUrl}#swapped`,
        costUsd: 0,
        report: { ...SWAPPED_REPORT },
      });
      await vi.advanceTimersByTimeAsync(0);
    };

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting rendered and swapped: two fillers submitted
    // Sent once the greeting is up; the greeting's own swap no longer shares the first tick with the reply's render.
    queue.push(REPLY_JOB);
    queue.push({ kind: "checkIn", channel: "chat" });
    pipeline.onRequestEnqueued();
    pipeline.nextClip();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // fillers take both filler slots, the reply its own; the reply's bridge filler renders
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // bridge filler queued; checkIn rendered
    const reply = started.find((clip) => clip.jobKind === "reply");
    const bridge = events.find(
      (event): event is Extract<PipelineEvent, { type: "clipRendered" }> =>
        event.type === "clipRendered" &&
        event.result.jobKind === "idle" &&
        event.result.seedFrameUrl === reply?.seedFrameUrl,
    )?.result;
    expect(bridge).toBeDefined();
    expect(started).not.toContain(bridge);

    await land(reply);
    expect(pipeline.nextClip()?.jobKind).toBe("reply");
    await land(started.find((clip) => clip.jobKind === "checkIn"));
    expect(pipeline.nextClip()?.jobKind).toBe("checkIn");

    // Playback is past the reply's tail now, so the bridge filler can never follow it.
    await land(started.find((clip) => clip.jobKind === "idle"));
    expect(started).not.toContain(bridge);
    expect(
      events.some(
        (event) =>
          event.type === "clipDiscarded" &&
          event.result.clipId === bridge?.clipId,
      ),
    ).toBe(true);
  });

  it("two-phase swap: a playable idle on the old anchor does not stop the bridge idle for a new chain tail while that clip's swap is in flight", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const finalize: Array<{
      result: ClipResult;
      deferred: Deferred<{
        videoUrl: string;
        costUsd: number;
        report: ClipResult["swap"] & object;
      }>;
    }> = [];
    const landed = (result: ClipResult) => ({
      videoUrl: `${result.videoUrl}.swapped.mp4`,
      costUsd: 0.004,
      report: {
        status: "swapped" as const,
        swapMs: 6000,
        frames: 264,
        framesWithFace: 264,
        msPerFrame: 22,
        similarityBefore: 0.6,
        similarityAfter: 0.9,
        restored: true,
        reason: null,
      },
    });
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => ({
          ...chainAdvancingResult(req),
          swap: {
            status: "pending" as const,
            swapMs: 0,
            frames: 0,
            framesWithFace: 0,
            msPerFrame: 0,
            similarityBefore: null,
            similarityAfter: null,
            restored: false,
            reason: null,
          },
        }));
      },
      finalizeSwap: (result) => {
        const deferred = defer<{
          videoUrl: string;
          costUsd: number;
          report: ClipResult["swap"] & object;
        }>();
        finalize.push({ result, deferred });
        return deferred.promise;
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting rendered, plays unswapped
    pipeline.nextClip();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // fillers on the greeting tail rendered
    for (const entry of finalize) {
      if (entry.result.jobKind === "idle") {
        entry.deferred.resolve(landed(entry.result));
      }
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.getBufferStats().idleReady).toBeGreaterThan(0);

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply rendered: new tail, its swap in flight
    const reply = finalize.find((e) => e.result.jobKind === "reply")?.result;
    expect(reply).toBeDefined();
    // The old-anchor idles cannot follow the reply, so the bridge idle from its tail is submitted now, not after the swap lands.
    expect(
      requests.some(
        (r) =>
          r.job.kind === "idle" &&
          r.session.seedFrameUrl === reply?.seedFrameUrl,
      ),
    ).toBe(true);
  });

  it("sizes the next idle to the slowest recent idle production plus headroom, within the clip bounds", async () => {
    // Five idles play on one anchor here; a full deck would stop the renders this test measures.
    const tunables = LIVE_TUNABLES as { IDLE_DECK_SIZE: number };
    const deckSize = tunables.IDLE_DECK_SIZE;
    tunables.IDLE_DECK_SIZE = 99;
    onTestFinished(() => {
      tunables.IDLE_DECK_SIZE = deckSize;
    });
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    let productionMs = 14_000;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        if (req.job.kind === "idle") {
          now += productionMs;
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    const idleJobs = () =>
      requests
        .filter((r) => r.job.kind === "idle")
        .map((r) => (r.job as Extract<ClipJob, { kind: "idle" }>).durationSec);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, first idle submitted
    // No measurement yet: the floor.
    expect(idleJobs()).toEqual([LIVE_TUNABLES.IDLE_CLIP_SEC]);

    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // the idle resolves, having taken 14s
    pipeline.nextClip(); // greeting
    pipeline.nextClip(); // the 10s idle -> refill
    expect(idleJobs().at(-1)).toBe(LIVE_TUNABLES.MAX_CLIP_SEC);

    // A fast one does not shorten the next idle while a slow one is still in the window.
    productionMs = 6_000;
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    pipeline.nextClip();
    expect(idleJobs().at(-1)).toBe(LIVE_TUNABLES.MAX_CLIP_SEC);

    // Once the window holds only fast productions (6s + 1s headroom < floor), it drops back to the floor.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
      pipeline.nextClip();
    }
    expect(idleJobs().at(-1)).toBe(LIVE_TUNABLES.IDLE_CLIP_SEC);
  });

  it("pre-stocks idles from a staged seed on turbo and plays them after the looping greeting", async () => {
    const stagedSnapshot: LiveSessionSnapshot = {
      ...snapshot,
      seedFrameUrl: "https://example.com/staged.jpg",
    };
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "turbo",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
    });
    pipeline.start({ kind: "greeting" }, () => stagedSnapshot, queue.next);
    expect(requests.filter((r) => r.job.kind === "idle")).toHaveLength(
      LIVE_TUNABLES.IDLE_BUFFER_TARGET,
    );
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(pipeline.nextClip()?.jobKind).toBe("greeting");
    // The greeting looped back to the staged still, so the pre-stocked idle matches the cursor.
    expect(pipeline.nextClip()?.jobKind).toBe("idle");
  });

  it("does not pre-stock idles at the join in swap mode, even on a staged seed", () => {
    const stagedSnapshot: LiveSessionSnapshot = {
      ...snapshot,
      seedFrameUrl: "https://example.com/staged.jpg",
    };
    const requests: ClipRequest[] = [];
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
    });
    pipeline.start(
      { kind: "greeting" },
      () => stagedSnapshot,
      makeJobQueue().next,
    );
    expect(requests.map((r) => r.job.kind)).toEqual(["greeting"]);
  });

  it("does not pre-stock idles from a raw upload seed on turbo, where the greeting chains away from it", () => {
    const requests: ClipRequest[] = [];
    const pipeline = trackedPipeline({
      backend: "turbo",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        return delayed(() => chainAdvancingResult(req));
      },
    });
    pipeline.start({ kind: "greeting" }, () => snapshot, makeJobQueue().next);
    expect(requests.map((r) => r.job.kind)).toEqual(["greeting"]);
  });

  it("nextFallbackClip hands out a same-look idle from an old anchor when nothing chained from the tail is ready", async () => {
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "reference",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => delayed(() => chainAdvancingResult(req)),
    });
    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    pipeline.nextClip();
    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    const reply = pipeline.nextClip();
    expect(reply?.jobKind).toBe("reply");
    // The bridge idle from the reply's tail is still rendering; the old-anchor idle is the fallback.
    const fallback = pipeline.nextFallbackClip();
    expect(fallback?.jobKind).toBe("idle");
    expect(fallback?.state).toEqual(liveState);
  });

  it("nextFallbackClip holds (null) while a chain clip's swap is still landing, even with a same-look idle on the shelf", async () => {
    const queue = makeJobQueue();
    const finalize: Array<{
      result: ClipResult;
      deferred: Deferred<{
        videoUrl: string;
        costUsd: number;
        report: ClipResult["swap"] & object;
      }>;
    }> = [];
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) =>
        delayed(() => ({
          ...chainAdvancingResult(req),
          swap: {
            status: "pending" as const,
            swapMs: 0,
            frames: 0,
            framesWithFace: 0,
            msPerFrame: 0,
            similarityBefore: null,
            similarityAfter: null,
            restored: false,
            reason: null,
          },
        })),
      finalizeSwap: (result) => {
        const deferred = defer<{
          videoUrl: string;
          costUsd: number;
          report: ClipResult["swap"] & object;
        }>();
        finalize.push({ result, deferred });
        return deferred.promise;
      },
    });
    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting rendered
    finalize[0]?.deferred.resolve({
      videoUrl: "https://example.com/greeting-swapped.mp4",
      costUsd: 0,
      report: { ...SWAPPED_REPORT },
    });
    await vi.advanceTimersByTimeAsync(0);
    pipeline.nextClip();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // fillers on the greeting tail rendered
    const landed = (result: ClipResult) => ({
      videoUrl: `${result.videoUrl}.swapped.mp4`,
      costUsd: 0.004,
      report: {
        status: "swapped" as const,
        swapMs: 6000,
        frames: 264,
        framesWithFace: 264,
        msPerFrame: 22,
        similarityBefore: 0.6,
        similarityAfter: 0.9,
        restored: true,
        reason: null,
      },
    });
    for (const entry of finalize) {
      if (entry.result.jobKind === "idle") {
        entry.deferred.resolve(landed(entry.result));
      }
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.getBufferStats().idleReady).toBeGreaterThan(0);

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply rendered, swap pending
    expect(pipeline.hasChainedReady()).toBe(false);
    // Same-look idles are playable, but the reply lands next and follows the tail; the boundary holds for it.
    expect(pipeline.nextFallbackClip()).toBeNull();

    const reply = finalize.find((e) => e.result.jobKind === "reply");
    reply?.deferred.resolve(landed(reply.result));
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.hasChainedReady()).toBe(true);
    expect(pipeline.nextClip()?.jobKind).toBe("reply");
  });

  it("nextFallbackClip returns null when no idle of the current look is ready", () => {
    const pipeline = trackedPipeline({
      backend: "turbo",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => delayed(() => chainAdvancingResult(req)),
    });
    pipeline.start({ kind: "greeting" }, () => snapshot, makeJobQueue().next);
    expect(pipeline.nextFallbackClip()).toBeNull();
  });

  it("swap mode starts a bridge idle for a new chain tail while two old-anchor idles are still in flight", async () => {
    const requests: ClipRequest[] = [];
    const queue = makeJobQueue();
    const oldIdles: Deferred<ClipResult>[] = [];
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => {
        requests.push(req);
        if (req.job.kind === "idle" && req.session.seedFrameUrl === ANCHOR_0) {
          const deferred = defer<ClipResult>();
          oldIdles.push(deferred);
          return deferred.promise; // old-anchor idles stay in flight
        }
        return delayed(() => chainAdvancingResult(req));
      },
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    pipeline.nextClip();
    expect(oldIdles.length).toBe(LIVE_TUNABLES.SWAP_IDLE_BUFFER_TARGET);

    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // reply settles on a fresh tail
    const tail = pipeline.getCurrentAnchorFrameUrl();
    expect(tail).not.toBe(ANCHOR_0);
    const bridge = requests.filter(
      (r) => r.job.kind === "idle" && r.session.seedFrameUrl === tail,
    );
    expect(bridge.length).toBe(1);
    expect(pipeline.getBufferStats().idleInflight).toBe(
      LIVE_TUNABLES.SWAP_IDLE_MAX_INFLIGHT,
    );

    // The old idles settle late: they no longer match the anchor and are discarded, freeing their slots.
    for (const deferred of oldIdles) {
      deferred.resolve(makeResult("idle", ANCHOR_0));
    }
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(pipeline.getBufferStats().idleInflight).toBeLessThan(
      LIVE_TUNABLES.SWAP_IDLE_MAX_INFLIGHT,
    );
  });

  it("swap mode never calls the fal upscaler: its own service restores the seed frame", async () => {
    const upscaleSeed = vi.fn(
      async (): Promise<{ url: string | null; costUsd: number }> => ({
        url: "https://example.com/restored.jpg",
        costUsd: 0.002,
      }),
    );
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
      backend: "swap",
      now: nowFn,
      onEvent: () => {},
      render: async (req) => delayed(() => chainAdvancingResult(req)),
      upscaleSeed,
    });

    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(upscaleSeed).not.toHaveBeenCalled();
  });

  describe("idle deck", () => {
    const idleRequestsOn = (requests: ClipRequest[], frameUrl: string) =>
      requests.filter(
        (r) => r.job.kind === "idle" && r.session.seedFrameUrl === frameUrl,
      );

    it("stops rendering idles once a settled pose has a full deck, and replays it without repeating one back to back", async () => {
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
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
      const greeting = pipeline.nextClip();
      pipeline.onClipStarted(greeting!.seedFrameUrl);

      const played: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
        const clip = pipeline.nextClip();
        expect(clip?.jobKind).toBe("idle");
        played.push(clip!.clipId);
      }
      const rendered = idleRequestsOn(requests, ANCHOR_0).length;
      // The deck plus at most the buffer that was already stocked or in flight when it filled.
      expect(rendered).toBeLessThanOrEqual(
        LIVE_TUNABLES.IDLE_DECK_SIZE +
          LIVE_TUNABLES.IDLE_BUFFER_TARGET +
          LIVE_TUNABLES.IDLE_MAX_INFLIGHT,
      );
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS * 10);
      expect(idleRequestsOn(requests, ANCHOR_0)).toHaveLength(rendered);
      for (let i = 1; i < played.length; i += 1) {
        expect(played[i]).not.toBe(played[i - 1]);
      }
      expect(new Set(played).size).toBeGreaterThanOrEqual(
        LIVE_TUNABLES.IDLE_DECK_SIZE,
      );
    });

    it("gives each idle of one pose its own variant, so the deck's cards carry different actions", async () => {
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
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
      pipeline.onClipStarted(pipeline.nextClip()!.seedFrameUrl);
      for (let i = 0; i < 6; i += 1) {
        await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
        pipeline.nextClip();
      }
      const variants = idleRequestsOn(requests, ANCHOR_0)
        .slice(0, LIVE_TUNABLES.IDLE_DECK_SIZE)
        .map((r) => (r.job as Extract<ClipJob, { kind: "idle" }>).variant);
      expect(new Set(variants).size).toBe(LIVE_TUNABLES.IDLE_DECK_SIZE);
    });

    it("drops an earlier pose's deck once a reply moves the anchor, and renders idles for the new pose", async () => {
      const requests: ClipRequest[] = [];
      const queue = makeJobQueue();
      const pipeline = trackedPipeline({
        now: nowFn,
        onEvent: () => {},
        render: async (req) => {
          requests.push(req);
          return delayed(() => lookChangingResult(req));
        },
      });
      pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
      pipeline.onClipStarted(pipeline.nextClip()!.seedFrameUrl);
      for (let i = 0; i < 8; i += 1) {
        await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
        pipeline.nextClip();
      }

      queue.push(REPLY_JOB);
      pipeline.onRequestEnqueued();
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
      let reply = pipeline.nextClip();
      while (reply && reply.jobKind !== "reply") {
        await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
        reply = pipeline.nextClip();
      }
      expect(reply?.jobKind).toBe("reply");
      pipeline.onClipStarted(reply!.seedFrameUrl);
      pipeline.pollChain();

      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
        const clip = pipeline.nextClip();
        expect(clip?.jobKind).toBe("idle");
        expect(clip?.seedFrameUrl).toBe(reply!.seedFrameUrl);
      }
      expect(
        idleRequestsOn(requests, reply!.seedFrameUrl).length,
      ).toBeGreaterThan(0);
    });
  });
});

describe("ClipPipeline split reply", () => {
  type Outcome = {
    videoUrl: string;
    lastFrameUrl?: string;
    costUsd: number;
    report: ClipSwapReport;
  };
  const PENDING: ClipSwapReport = {
    ...SWAPPED_REPORT,
    status: "pending",
    frames: 0,
  };
  const HEAD_SEC = 100 / 24;
  const headOutcome: Outcome = {
    videoUrl: "https://example.com/head-swapped.mp4",
    costUsd: 0.002,
    report: { ...SWAPPED_REPORT, frames: 100, fps: 24 },
  };
  const restOutcome: Outcome = {
    videoUrl: "https://example.com/rest-swapped.mp4",
    costUsd: 0.003,
    report: { ...SWAPPED_REPORT, frames: 140, fps: 24 },
  };
  const pipelines: ClipPipeline[] = [];

  beforeEach(() => {
    resultCounter = 0;
    frameCounter = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const pipeline of pipelines.splice(0)) {
      pipeline.dispose();
    }
    vi.useRealTimers();
  });

  // Greeting played, reply rendered with its swap pending; the reply's head and rest are the test's to settle. Fillers swap instantly.
  const rig = async () => {
    const events: PipelineEvent[] = [];
    const head = defer<Outcome>();
    const rest = defer<Outcome>();
    const queue = makeJobQueue();
    const pipeline = new ClipPipeline({
      backend: "swap",
      now: () => 0,
      onEvent: (event) => events.push(event),
      render: async (req) =>
        delayed(() => ({ ...chainAdvancingResult(req), swap: PENDING })),
      finalizeSwap: (result) =>
        result.jobKind === "reply"
          ? head.promise.then((swapped) => ({
              ...swapped,
              rest: rest.promise,
            }))
          : Promise.resolve({
              videoUrl: `${result.videoUrl}?swapped`,
              costUsd: 0.001,
              report: SWAPPED_REPORT,
            }),
    });
    pipelines.push(pipeline);
    queue.push(REPLY_JOB);
    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(pipeline.nextClip()?.jobKind).toBe("greeting");
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    const rendered = events.find(
      (e) => e.type === "clipRendered" && e.result.jobKind === "reply",
    );
    const renderedVideoUrl =
      rendered?.type === "clipRendered" ? rendered.result.videoUrl : "";
    expect(renderedVideoUrl).not.toBe("");
    return { pipeline, events, head, rest, renderedVideoUrl };
  };

  it("plays the head once it lands, holds for the rest with no filler between them, then plays the swapped rest", async () => {
    const { pipeline, events, head, rest } = await rig();
    head.resolve(headOutcome);
    await vi.advanceTimersByTimeAsync(0);
    const headClip = pipeline.nextClip();
    expect(headClip?.videoUrl).toBe(headOutcome.videoUrl);
    expect(headClip?.durationSec).toBeCloseTo(HEAD_SEC);
    // Bridge fillers from the reply's tail render and swap meanwhile; none may cut in before the rest.
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS * 4);
    const seen = events.length;
    expect(pipeline.nextClip()).toBeNull();
    expect(events.slice(seen).some((e) => e.type === "bufferEmpty")).toBe(
      false,
    );

    rest.resolve(restOutcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some((e) => e.type === "clipPartReady")).toBe(true);
    const part = pipeline.nextClip();
    expect(part?.clipId).toBe(`${headClip?.clipId}:rest`);
    expect(part?.videoUrl).toBe(restOutcome.videoUrl);
    expect(part?.seedFrameUrl).toBe(headClip?.seedFrameUrl);
    expect(pipeline.startSecFor(part?.clipId ?? "")).toBeUndefined();
    expect(part?.costUsd).toBe(restOutcome.costUsd);
    // After the rest, the tail's fillers are fair game again.
    expect(pipeline.nextClip()?.jobKind).toBe("idle");
  });

  it("a failed rest plays the raw render from the head's last frame on, rather than freezing", async () => {
    const { pipeline, head, rest, renderedVideoUrl } = await rig();
    head.resolve(headOutcome);
    await vi.advanceTimersByTimeAsync(0);
    pipeline.nextClip();
    rest.reject(new Error("Modal 503"));
    await vi.advanceTimersByTimeAsync(0);
    const part = pipeline.nextClip();
    expect(part?.videoUrl).toBe(renderedVideoUrl);
    expect(part?.swap?.status).toBe("failed");
    expect(pipeline.startSecFor(part?.clipId ?? "")).toBeCloseTo(HEAD_SEC);
  });

  it("a rest still out SWAP_SPLIT_REST_LEAD_MS before the head ends plays raw, and its late swap is discarded", async () => {
    const { pipeline, events, head, rest, renderedVideoUrl } = await rig();
    head.resolve(headOutcome);
    await vi.advanceTimersByTimeAsync(0);
    const headClip = pipeline.nextClip();
    pipeline.onClipStarted(headClip?.seedFrameUrl ?? "", headClip?.clipId);
    await vi.advanceTimersByTimeAsync(
      HEAD_SEC * 1000 - LIVE_TUNABLES.SWAP_SPLIT_REST_LEAD_MS - 50,
    );
    expect(events.some((e) => e.type === "clipPartReady")).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(events.some((e) => e.type === "clipPartReady")).toBe(true);
    const part = pipeline.nextClip();
    expect(part?.videoUrl).toBe(renderedVideoUrl);

    rest.resolve(restOutcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(part?.videoUrl).toBe(renderedVideoUrl);
    expect(
      events.some(
        (e) =>
          e.type === "clipDiscarded" &&
          e.result.clipId === part?.clipId &&
          e.costUsd === restOutcome.costUsd,
      ),
    ).toBe(true);
  });

  it("a head that fell back to the whole unswapped clip plays alone, and the rest's cost is still counted", async () => {
    const { pipeline, events, head, rest, renderedVideoUrl } = await rig();
    head.resolve({
      videoUrl: renderedVideoUrl,
      costUsd: 0,
      report: { ...PENDING, status: "failed", reason: "timeout" },
    });
    await vi.advanceTimersByTimeAsync(0);
    const whole = pipeline.nextClip();
    expect(whole?.videoUrl).toBe(renderedVideoUrl);
    expect(whole?.durationSec).toBe(10);
    rest.resolve(restOutcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some((e) => e.type === "clipPartReady")).toBe(false);
    expect(
      events.some(
        (e) => e.type === "clipDiscarded" && e.costUsd === restOutcome.costUsd,
      ),
    ).toBe(true);
  });

  it("a head that came back whole (a swap service that ignored the range) plays alone instead of twice", async () => {
    const { pipeline, events, head, rest } = await rig();
    head.resolve({
      ...headOutcome,
      report: { ...SWAPPED_REPORT, frames: 241, fps: 24 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.nextClip()?.durationSec).toBe(10);
    rest.resolve(restOutcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some((e) => e.type === "clipPartReady")).toBe(false);
  });

  it("a held slot keeps idle swaps off the rest's container but never blocks a chain swap", async () => {
    const idleSwaps: string[] = [];
    const queue = makeJobQueue();
    const pipeline = new ClipPipeline({
      backend: "swap",
      now: () => 0,
      onEvent: () => {},
      render: async (req) =>
        delayed(() => ({ ...chainAdvancingResult(req), swap: PENDING })),
      finalizeSwap: (result) => {
        if (result.jobKind === "idle") {
          idleSwaps.push(result.clipId);
        }
        // The greeting lands at once so it holds no chain slot.
        return result.jobKind === "greeting"
          ? Promise.resolve({
              videoUrl: result.videoUrl,
              costUsd: 0,
              report: { ...SWAPPED_REPORT },
            })
          : new Promise(() => {});
      },
    });
    pipelines.push(pipeline);
    const release = pipeline.holdSwapSlot();
    expect(pipeline.swapLoad()).toBe(1);
    pipeline.start({ kind: "greeting" }, () => snapshot, queue.next);
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS * 4);
    // SWAP_MAX_CONCURRENT 3 keeps one slot for the chain: two idle swaps, one with the held slot.
    expect(idleSwaps.length).toBe(LIVE_TUNABLES.SWAP_MAX_CONCURRENT - 2);
    queue.push(REPLY_JOB);
    pipeline.onRequestEnqueued();
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(pipeline.swapLoad()).toBe(idleSwaps.length + 2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(idleSwaps.length).toBe(LIVE_TUNABLES.SWAP_MAX_CONCURRENT - 1);
  });
});
