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

  it("never plays an idle filler before the greeting, even if the idle render finishes first", async () => {
    const greetingDeferred = defer<ClipResult>();
    const queue = makeJobQueue();
    const pipeline = trackedPipeline({
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
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // greeting resolves, initial idles submitted
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // two idles fail once, retried
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // retries succeed, rest resolve normally

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
        return delayed(() => chainAdvancingResult(req));
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
        return delayed(() => chainAdvancingResult(req));
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
});
