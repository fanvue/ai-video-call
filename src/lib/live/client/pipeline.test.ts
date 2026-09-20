import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipPipeline, type PipelineEvent } from "./pipeline";
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

const snapshot: LiveSessionSnapshot = {
  creator: {
    id: "c1",
    displayName: "Her",
    lookLock: "",
    sceneId: "bedroom",
    tipMenu: [],
  },
  state: liveState,
  seedFrameUrl: "https://example.com/seed.jpg",
  anchorFrameUrl: "https://example.com/anchor.jpg",
  elapsedSec: 0,
  transcript: [],
};

const makeResult = (
  jobKind: ClipResult["jobKind"],
  clipId: string,
): ClipResult => ({
  clipId,
  jobKind,
  videoUrl: `https://example.com/${clipId}.mp4`,
  durationSec: 10,
  seedFrameUrl: "https://example.com/next-seed.jpg",
  state: liveState,
  reply: null,
  followUps: [],
  guard: { checked: true, issues: [], repaired: false },
  timings: { planMs: 1, renderMs: 1, frameMs: 1, guardMs: 1, repairMs: 1 },
  costUsd: 0.02,
});

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

// The pipeline resubmits the instant a render resolves, so an instant-resolving fake would spin
// forever; every fake render settles via a fake timer that the test steps explicitly instead.
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
    pipelines.length = 0;
    vi.useFakeTimers();
  });

  // Disposing stops the chain from resubmitting once a test's assertions are done.
  afterEach(() => {
    for (const pipeline of pipelines) {
      pipeline.dispose();
    }
    vi.useRealTimers();
  });

  it("chains seeds: submits N+1 the moment N resolves, buffering at most one ready clip", async () => {
    const events: PipelineEvent[] = [];
    const jobs: ClipJob[] = [
      { kind: "idle" },
      { kind: "idle" },
      { kind: "idle" },
    ];
    let jobIndex = 0;
    const requests: ClipRequest[] = [];
    // Mirrors how the director's real snapshot reflects each clip's seedFrameUrl once it lands.
    let currentSeed = snapshot.seedFrameUrl;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async (req) => {
        requests.push(req);
        return delayed(() => {
          const result = makeResult("idle", `clip-${requests.length}`);
          currentSeed = result.seedFrameUrl;
          return result;
        });
      },
    });

    pipeline.start(
      jobs[jobIndex++],
      () => ({ ...snapshot, seedFrameUrl: currentSeed }),
      () => jobs[jobIndex++] ?? { kind: "idle" },
    );
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(pipeline.peekReady()).not.toBeNull();
    expect(events.map((e) => e.type)).toEqual(["clipReady"]);

    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]?.session.seedFrameUrl).toBe(
      "https://example.com/next-seed.jpg",
    );
  });

  it("abandons a young in-flight idle when a fan request arrives, cost still reported", async () => {
    const events: PipelineEvent[] = [];
    const idleDeferred = defer<ClipResult>();
    let renderCalls = 0;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async () => {
        renderCalls += 1;
        if (renderCalls === 1) {
          return idleDeferred.promise;
        }
        return delayed(() => makeResult("reply", "clip-reply"));
      },
    });

    pipeline.start(
      { kind: "idle" },
      () => snapshot,
      () => ({ kind: "idle" }),
    );
    now = 1000; // well inside ABANDON_INFLIGHT_MS
    pipeline.onRequestEnqueued({
      kind: "reply",
      requestId: "r1",
      text: "hi",
      channel: "chat",
    });

    idleDeferred.resolve(makeResult("idle", "clip-idle-late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some((e) => e.type === "clipAbandoned")).toBe(true);
    const abandoned = events.find((e) => e.type === "clipAbandoned");
    expect(abandoned).toMatchObject({ costUsd: 0.02 });

    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(events.some((e) => e.type === "clipReady")).toBe(true);
    const ready = events.find((e) => e.type === "clipReady");
    expect(ready && "result" in ready && ready.result.jobKind).toBe("reply");
  });

  it("does not abandon an in-flight idle once it is past the abandon window", () => {
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: () => {},
      render: () => new Promise<ClipResult>(() => {}),
    });
    pipeline.start(
      { kind: "idle" },
      () => snapshot,
      () => ({ kind: "idle" }),
    );
    now = 5000; // past ABANDON_INFLIGHT_MS (3000)
    pipeline.onRequestEnqueued({
      kind: "reply",
      requestId: "r1",
      text: "hi",
      channel: "chat",
    });
    expect(pipeline.isBusy()).toBe(true);
  });

  it("retries a failed render once, then reports error and falls back to idle", async () => {
    const events: PipelineEvent[] = [];
    let attempts = 0;
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async () => {
        attempts += 1;
        return delayed(() => {
          throw new Error("render failed");
        });
      },
    });
    pipeline.start(
      { kind: "idle" },
      () => snapshot,
      () => ({ kind: "idle" }),
    );
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 1 fails, retries immediately
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS); // attempt 2 fails, reports error + submits the idle fallback (attempt 3)
    expect(attempts).toBe(3);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("emits bufferEmpty when advancing without a clip already buffered", async () => {
    const events: PipelineEvent[] = [];
    const pipeline = trackedPipeline({
      now: nowFn,
      onEvent: (e) => events.push(e),
      render: async () => delayed(() => makeResult("idle", "clip-x")),
    });
    pipeline.start(
      { kind: "idle" },
      () => snapshot,
      () => ({ kind: "idle" }),
    );
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(events.some((e) => e.type === "clipReady")).toBe(true);
    pipeline.takeReady();
    events.length = 0;
    await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);
    expect(events.some((e) => e.type === "bufferEmpty")).toBe(true);
  });
});
