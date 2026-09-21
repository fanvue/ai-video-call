import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_TUNABLES } from "@/lib/live/contract";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import {
  DirectorSession,
  type DirectorOpenInput,
  type DirectorRealtimeHandle,
  type DirectorRealtimeState,
  type DirectorSessionDeps,
  type OpenRealtime,
  type OpenRealtimeOptions,
} from "@/lib/live/client/directorStream";

// Real fal handshake takes 30s to time out; kept in sync with the private CONFIGURE_TIMEOUT_MS.
const CONFIGURE_TIMEOUT_MS = 30_000;

type SentMessage = Record<string, unknown>;

// Minimal stand-in for the fal ManagedRealtimeSession the WMA extension returns.
class FakeHandle implements DirectorRealtimeHandle {
  state: DirectorRealtimeState = "opening";
  sent: SentMessage[] = [];
  closeCalls = 0;
  private resolveReady!: (value?: unknown) => void;
  private rejectReady!: (error: unknown) => void;
  readonly ready: Promise<unknown>;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  goLive(): void {
    this.resolveReady();
  }

  fail(error: unknown): void {
    this.rejectReady(error);
  }

  send(message: SentMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

type Captured = { handle: FakeHandle; options: OpenRealtimeOptions };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

// Shared by every test: builds deps whose openRealtime captures the handle/options it was given.
const makeDeps = (
  overrides: Partial<DirectorSessionDeps>,
): { deps: DirectorSessionDeps; captured: { current: Captured | null } } => {
  const captured: { current: Captured | null } = { current: null };
  const openRealtime =
    (): OpenRealtime =>
    (options: OpenRealtimeOptions): DirectorRealtimeHandle => {
      const handle = new FakeHandle();
      captured.current = { handle, options };
      return handle;
    };
  const deps: DirectorSessionDeps = {
    openRealtime: vi.fn(openRealtime),
    now: vi.fn(() => 0),
    composePrompt: vi.fn().mockResolvedValue({
      prompt: "steering prompt",
      reply: "sure thing",
    }),
    onTranscriptEntry: vi.fn(),
    onRequestStatus: vi.fn(),
    onStreamState: vi.fn(),
    onMedia: vi.fn(),
    onMetrics: vi.fn(),
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

const baseInput = (): DirectorOpenInput => ({
  creator: defaultCreatorProfile(
    "Her",
    "bedroom",
    "long dark hair, brown eyes",
  ),
  world: "bedroom",
  surroundings: "a small bedroom with fairy lights and a white duvet",
  wardrobe: {
    top: { on: true, description: "black ribbed tank top" },
    bottom: { on: false, description: "grey shorts" },
    bra: { on: true, description: "black lace bra" },
    panties: { on: true, description: "black panties" },
    removedOrder: ["bottom"],
  },
  anchorFrameUrl: "https://fal.example.com/anchor.jpg",
  speechMode: "text",
  startedAtMs: 0,
});

// Wires a DirectorSession against a FakeHandle, driving the open() handshake to "configured".
const openSession = async (
  overrides: Partial<DirectorSessionDeps> = {},
): Promise<{
  session: DirectorSession;
  captured: Captured;
  deps: DirectorSessionDeps;
}> => {
  const { deps, captured } = makeDeps(overrides);
  const session = new DirectorSession(deps);
  const openPromise = session.open(baseInput());
  await flush();
  const captured1 = requireCaptured(captured);
  captured1.handle.goLive();
  await flush();
  captured1.options.onData(JSON.stringify({ type: "configured" }));
  await openPromise;
  return { session, captured: captured1, deps };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DirectorSession.open", () => {
  it("sends configure with the anchor frame url once the handle is live", async () => {
    const { captured } = await openSession();
    const configureMessages = captured.handle.sent.filter(
      (m) => m.type === "configure",
    );
    expect(configureMessages).toHaveLength(1);
    expect(configureMessages[0]).toMatchObject({
      image_url: "https://fal.example.com/anchor.jpg",
      aspect_ratio: "9:16",
      memory: 40,
    });
  });

  it("opens with a full premise: look lock, worn garments only, the real room, and the speech rule", async () => {
    const { captured } = await openSession();
    const configure = captured.handle.sent.find((m) => m.type === "configure");
    const prompt = (configure as { prompt: string }).prompt;
    expect(prompt).toContain("long dark hair, brown eyes");
    expect(prompt).toContain(
      "black ribbed tank top, black lace bra, black panties",
    );
    expect(prompt).not.toContain("grey shorts");
    expect(prompt).toContain("fairy lights");
    expect(prompt).toContain("She does not speak");
    expect(prompt).toContain("webcam livestream");
  });

  it("rejects open() as soon as the server answers configure with an error, naming the reason", async () => {
    const onError = vi.fn();
    const { deps, captured } = makeDeps({ onError });
    const session = new DirectorSession(deps);

    const openPromise = session.open(baseInput());
    await flush();
    const captured1 = requireCaptured(captured);
    captured1.handle.goLive();
    await flush();
    const assertion = expect(openPromise).rejects.toThrow("content_policy");
    captured1.options.onData(
      JSON.stringify({
        type: "error",
        code: "content_policy",
        error: "content_policy: opening image",
      }),
    );
    await assertion;

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("content_policy"),
    );
    expect(captured1.handle.closeCalls).toBe(1);
  });

  it("names the transport state and last diagnostic when configure times out", async () => {
    const onError = vi.fn();
    const { deps, captured } = makeDeps({ onError });
    const session = new DirectorSession(deps);

    const openPromise = session.open(baseInput());
    await flush();
    const captured1 = requireCaptured(captured);
    captured1.options.onDiagnostic?.({
      kind: "progress",
      phase: "connection-state",
      detail: { state: "connecting" },
    });
    const assertion = expect(openPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(CONFIGURE_TIMEOUT_MS);
    await assertion;

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("connection-state state=connecting"),
    );
  });

  it("fails closed and closes the handle if configure never arrives", async () => {
    const onError = vi.fn();
    const { deps, captured } = makeDeps({ onError });
    const session = new DirectorSession(deps);

    const openPromise = session.open(baseInput());
    await flush();
    const captured1 = requireCaptured(captured);
    captured1.handle.goLive();
    await flush();
    // Never send "configured" — advance past the timeout instead.
    const assertion = expect(openPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(CONFIGURE_TIMEOUT_MS);
    await assertion;

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("took too long"),
    );
    expect(captured1.handle.closeCalls).toBe(1);
  });
});

describe("DirectorSession.request", () => {
  it("sends strictly-incrementing prompt_version for two rapid requests, in call order, with replan:false", async () => {
    const { session, captured } = await openSession();

    session.request("dance for me", "chat");
    session.request("blow a kiss", "chat");
    await flush();

    const promptMessages = captured.handle.sent.filter(
      (m) => m.type === "prompt",
    );
    expect(promptMessages).toHaveLength(2);
    expect(promptMessages[0]).toMatchObject({
      prompt_version: 2,
      replan: false,
    });
    expect(promptMessages[1]).toMatchObject({
      prompt_version: 3,
      replan: false,
    });
  });

  it("marks a request generating, then playing once a chunk at its version arrives", async () => {
    const onRequestStatus = vi.fn();
    const { session, captured } = await openSession({ onRequestStatus });

    session.request("dance for me", "chat");
    await flush();
    const requestId = onRequestStatus.mock.calls[0]?.[0] as string;
    expect(onRequestStatus).toHaveBeenCalledWith(requestId, "queued");

    captured.options.onData(
      JSON.stringify({ type: "prompt_applied", prompt_version: 2 }),
    );
    expect(onRequestStatus).toHaveBeenCalledWith(requestId, "generating");

    captured.options.onData(
      JSON.stringify({ type: "chunk", prompt_version: 2 }),
    );
    expect(onRequestStatus).toHaveBeenCalledWith(requestId, "playing");
  });

  it("isolates a prompt_rejected failure to only that request", async () => {
    const onRequestStatus = vi.fn();
    const onTranscriptEntry = vi.fn();
    const { session, captured } = await openSession({
      onRequestStatus,
      onTranscriptEntry,
    });

    session.request("dance for me", "chat");
    session.request("blow a kiss", "chat");
    await flush();

    const rejectedRequestId = onRequestStatus.mock.calls.find(
      ([, status]) => status === "queued",
    )?.[0] as string;

    captured.options.onData(
      JSON.stringify({
        type: "prompt_rejected",
        prompt_version: 2,
        reason: "content_policy",
      }),
    );

    expect(onRequestStatus).toHaveBeenCalledWith(rejectedRequestId, "failed");
    // The rejection produced exactly one failure line, not a retry.
    const failureEntries = onTranscriptEntry.mock.calls
      .map(([entry]) => entry as { id: string })
      .filter((entry) => entry.id.startsWith("director-failure-"));
    expect(failureEntries).toHaveLength(1);

    // The second request's own lifecycle is untouched by the first one's rejection.
    captured.options.onData(
      JSON.stringify({ type: "chunk", prompt_version: 3 }),
    );
    expect(onRequestStatus).toHaveBeenCalledWith(
      expect.stringMatching(/^director-fan-/),
      "playing",
    );
  });
});

describe("DirectorSession end conditions", () => {
  it("ends the session on stream_exhausted", async () => {
    const onEnded = vi.fn();
    const { captured } = await openSession({ onEnded });

    captured.options.onData(JSON.stringify({ type: "stream_exhausted" }));

    expect(onEnded).toHaveBeenCalledWith("streamExhausted");
    expect(captured.handle.closeCalls).toBe(1);
  });

  it("surfaces and ends the session on a server error message", async () => {
    const onEnded = vi.fn();
    const onError = vi.fn();
    const { captured } = await openSession({ onEnded, onError });

    captured.options.onData(
      JSON.stringify({ type: "error", code: "generation_failed" }),
    );

    expect(onError).toHaveBeenCalledWith("generation_failed");
    expect(onEnded).toHaveBeenCalledWith("error");
    // A fatal error should not send `stop` — the connection is already gone server-side.
    expect(captured.handle.sent.some((m) => m.type === "stop")).toBe(false);
  });

  it("stops the stream once MAX_SESSION_MS elapses", async () => {
    const onEnded = vi.fn();
    const { captured } = await openSession({ onEnded });

    await vi.advanceTimersByTimeAsync(LIVE_TUNABLES.MAX_SESSION_MS);

    expect(onEnded).toHaveBeenCalledWith("maxDuration");
    expect(captured.handle.sent.some((m) => m.type === "stop")).toBe(true);
    expect(captured.handle.closeCalls).toBe(1);
  });

  it("close() is idempotent and only reports the first end reason", async () => {
    const onEnded = vi.fn();
    const { session } = await openSession({ onEnded });

    session.close();
    session.close();

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith("stopped");
  });
});
