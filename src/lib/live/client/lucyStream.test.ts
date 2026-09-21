import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LucySession,
  type LucyOpenInput,
  type LucyRealtimeHandle,
  type LucyRealtimeState,
  type LucySessionDeps,
  type OpenLucyRealtimeOptions,
} from "@/lib/live/client/lucyStream";

const OPEN_TIMEOUT_MS = 30_000;

class FakeHandle implements LucyRealtimeHandle {
  state: LucyRealtimeState = "opening";
  closeCalls = 0;
  readonly ready: Promise<unknown> = new Promise(() => {});

  close(): void {
    this.closeCalls += 1;
  }
}

type Captured = { handle: FakeHandle; options: OpenLucyRealtimeOptions };

const makeDeps = (
  overrides: Partial<LucySessionDeps> = {},
): { deps: LucySessionDeps; captured: { current: Captured | null } } => {
  const captured: { current: Captured | null } = { current: null };
  const openRealtime = (
    options: OpenLucyRealtimeOptions,
  ): LucyRealtimeHandle => {
    const handle = new FakeHandle();
    captured.current = { handle, options };
    return handle;
  };
  const deps: LucySessionDeps = {
    fetchToken: vi.fn().mockResolvedValue("test-lucy-token"),
    openRealtime: vi.fn(openRealtime),
    now: vi.fn(() => 0),
    onStreamState: vi.fn(),
    onMedia: vi.fn(),
    onError: vi.fn(),
    onEnded: vi.fn(),
    ...overrides,
  };
  return { deps, captured };
};

const requireCaptured = (captured: { current: Captured | null }): Captured => {
  if (!captured.current) {
    throw new Error("openRealtime was never called");
  }
  return captured.current;
};

// jsdom has no MediaStream constructor; a plain stand-in is enough since LucySession only forwards it.
const fakeDrivingStream = {} as MediaStream;

const baseInput = (): LucyOpenInput => ({
  referenceImageUrl: "https://fal.example.com/anchor.jpg",
  prompt: "hold her look",
  drivingStream: fakeDrivingStream,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LucySession.open", () => {
  it("resolves once onState reports live, and never touches fal.config credentials", async () => {
    const { deps, captured } = makeDeps();
    const session = new LucySession(deps);

    const openPromise = session.open(baseInput());
    const { options } = requireCaptured(captured);
    options.onState("live");
    await openPromise;

    expect(options.referenceImageUrl).toBe(baseInput().referenceImageUrl);
    expect(options.prompt).toBe("hold her look");
  });

  it("fails closed and closes the handle if the stream never goes live", async () => {
    const onError = vi.fn();
    const { deps, captured } = makeDeps({ onError });
    const session = new LucySession(deps);

    const openPromise = session.open(baseInput());
    const assertion = expect(openPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    await assertion;

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("too long"));
    expect(requireCaptured(captured).handle.closeCalls).toBe(1);
  });

  it("surfaces a stream error and rejects without retrying", async () => {
    const onError = vi.fn();
    const onEnded = vi.fn();
    const { deps, captured } = makeDeps({ onError, onEnded });
    const session = new LucySession(deps);

    const openPromise = session.open(baseInput());
    const { options } = requireCaptured(captured);
    const assertion = expect(openPromise).rejects.toThrow("content policy");
    options.onError(new Error("content policy"));
    await assertion;

    expect(onError).toHaveBeenCalledWith("content policy");
    expect(onEnded).toHaveBeenCalledWith("error");
    expect(deps.openRealtime).toHaveBeenCalledTimes(1);
  });

  it("ends the session if the handle reports failed after going live", async () => {
    const onEnded = vi.fn();
    const { deps, captured } = makeDeps({ onEnded });
    const session = new LucySession(deps);

    const openPromise = session.open(baseInput());
    const { options } = requireCaptured(captured);
    options.onState("live");
    await openPromise;

    options.onState("failed");

    expect(onEnded).toHaveBeenCalledWith("error");
  });
});

describe("LucySession cost", () => {
  it("bills plain elapsed time with no session minimum", async () => {
    let nowMs = 0;
    const { deps, captured } = makeDeps({ now: () => nowMs });
    const session = new LucySession(deps);

    const openPromise = session.open(baseInput());
    const { options } = requireCaptured(captured);
    options.onState("live");
    await openPromise;

    nowMs = 10_000;
    const metrics = session.getMetricsWithCost();
    expect(metrics.costUsd).toBeCloseTo(10 * 0.02, 5);
  });
});

describe("LucySession.close", () => {
  it("is idempotent, closes the handle, and sends nothing further", async () => {
    const onEnded = vi.fn();
    const { deps, captured } = makeDeps({ onEnded });
    const session = new LucySession(deps);

    const openPromise = session.open(baseInput());
    const { handle } = requireCaptured(captured);
    (
      requireCaptured(captured).options.onState as (
        state: LucyRealtimeState,
      ) => void
    )("live");
    await openPromise;

    session.close();
    session.close();

    expect(handle.closeCalls).toBe(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith("stopped");
  });

  it("reports a server-side close of a live stream as streamClosed, not as our own stop", async () => {
    const onEnded = vi.fn();
    const { deps, captured } = makeDeps({ onEnded });
    const session = new LucySession(deps);
    const openPromise = session.open(baseInput());
    const onState = requireCaptured(captured).options.onState as (
      state: LucyRealtimeState,
    ) => void;
    onState("live");
    await openPromise;

    onState("closed");

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith("streamClosed");
  });
});
