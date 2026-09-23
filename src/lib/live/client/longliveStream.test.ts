import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";
import {
  buildLongLiveSocketUrl,
  FramePacer,
  LONGLIVE_MIN_ACTION_MS,
  LONGLIVE_SETTLE_AFTER_MS,
  LONGLIVE_WARDROBE_CHECK_AFTER_MS,
  LONGLIVE_WARDROBE_CHECK_ATTEMPTS,
  LONGLIVE_WARDROBE_CHECK_EVERY_MS,
  LongLiveSession,
  type LongLiveComposeInput,
  type LongLiveFrame,
  type LongLiveSessionDeps,
  type PacedFrame,
  type WebSocketLike,
} from "@/lib/live/client/longliveStream";
import type { RequestStatus } from "@/lib/live/client/director";
import { LIVE_TUNABLES, type LiveState } from "@/lib/live/contract";

type FakeFrame = PacedFrame & { id: number; closed: boolean };

let frameSeq = 0;
const makeFrame = (): FakeFrame => {
  frameSeq += 1;
  const frame: FakeFrame = {
    id: frameSeq,
    width: 480,
    height: 832,
    closed: false,
    close: () => {
      frame.closed = true;
    },
  };
  return frame;
};

describe("FramePacer", () => {
  it("shows the very first frame at once, then waits for the lead before pacing", () => {
    const pacer = new FramePacer<FakeFrame>(16, { leadSec: 0.5 });
    const first = makeFrame();
    pacer.push(first);
    expect(pacer.tick(0)).toBe(first);
    // Lead is 8 frames at 16 fps; until it fills the first frame stays up.
    for (let i = 0; i < 7; i += 1) pacer.push(makeFrame());
    expect(pacer.tick(100)).toBeNull();
    pacer.push(makeFrame());
    expect(pacer.tick(200)).not.toBeNull();
    expect(first.closed).toBe(true);
  });

  it("paces at the stream fps once the buffer is full", () => {
    const pacer = new FramePacer<FakeFrame>(16, { leadSec: 0.5 });
    for (let i = 0; i < 24; i += 1) pacer.push(makeFrame());
    let painted = 0;
    // One second of 4 ms ticks (a fast display) paints about 16 frames, not 250.
    for (let t = 0; t <= 1000; t += 4) {
      if (pacer.tick(t)) painted += 1;
    }
    expect(painted).toBeGreaterThanOrEqual(15);
    expect(painted).toBeLessThanOrEqual(18);
  });

  it("plays slower when the buffer runs low instead of freezing", () => {
    const pacer = new FramePacer<FakeFrame>(16, { leadSec: 0.5 });
    for (let i = 0; i < 8; i += 1) pacer.push(makeFrame());
    pacer.tick(0);
    // 7 left of a lead of 8 is normal speed; drain to a couple and the rate drops below 1.
    let t = 0;
    while (pacer.bufferedFrames > 2) {
      t += 4;
      pacer.tick(t);
    }
    t += 200;
    pacer.tick(t);
    expect(pacer.playbackRate).toBeLessThan(1);
  });

  it("holds the last frame on an underrun, counts it once and deepens the lead", () => {
    const pacer = new FramePacer<FakeFrame>(16, { leadSec: 0.5 });
    const frames = Array.from({ length: 8 }, makeFrame);
    for (const frame of frames) pacer.push(frame);
    let t = 0;
    let last: FakeFrame | null = null;
    while (pacer.bufferedFrames > 0 || t < 2000) {
      t += 10;
      last = pacer.tick(t) ?? last;
    }
    expect(last).toBe(frames[7]);
    expect(frames[7]?.closed).toBe(false);
    expect(pacer.lastFrame).toBe(frames[7]);
    expect(pacer.underruns).toBe(1);
    expect(pacer.leadFrames).toBeGreaterThan(8);
    // A frame arriving mid-starvation plays straight away, no rebuffer wait.
    const late = makeFrame();
    pacer.push(late);
    expect(pacer.tick(t + 10)).toBe(late);
  });

  it("does not burst through a backlog after a stall", () => {
    const pacer = new FramePacer<FakeFrame>(16, { leadSec: 0.5 });
    for (let i = 0; i < 40; i += 1) pacer.push(makeFrame());
    pacer.tick(0);
    let painted = 0;
    // A 3 s hidden-tab gap, then normal ticking: only a frame or two land at once.
    for (let t = 3000; t <= 3100; t += 4) {
      if (pacer.tick(t)) painted += 1;
    }
    expect(painted).toBeLessThanOrEqual(3);
  });

  it("drops the oldest frames past the hard cap and closes them", () => {
    const pacer = new FramePacer<FakeFrame>(16, { maxBufferSec: 1 });
    const frames = Array.from({ length: 20 }, makeFrame);
    for (const frame of frames) pacer.push(frame);
    expect(pacer.bufferedFrames).toBe(16);
    expect(pacer.dropped).toBe(4);
    expect(frames[0]?.closed).toBe(true);
    expect(frames[19]?.closed).toBe(false);
  });

  it("closes every bitmap on dispose", () => {
    const pacer = new FramePacer<FakeFrame>(16);
    const frames = Array.from({ length: 3 }, makeFrame);
    for (const frame of frames) pacer.push(frame);
    pacer.tick(0);
    pacer.dispose();
    expect(frames.every((frame) => frame.closed)).toBe(true);
  });
});

describe("buildLongLiveSocketUrl", () => {
  it("appends the ws path and url-encodes the ticket", () => {
    expect(buildLongLiveSocketUrl("wss://x.modal.run/", "a.b+c")).toBe(
      "wss://x.modal.run/ws?ticket=a.b%2Bc",
    );
    expect(buildLongLiveSocketUrl("https://x.modal.run", "t")).toBe(
      "wss://x.modal.run/ws?ticket=t",
    );
  });
});

class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverText(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverFrame(index: number): void {
    const buffer = new ArrayBuffer(4 + 8);
    new DataView(buffer).setUint32(0, index);
    this.onmessage?.({ data: buffer });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};

const creator = defaultCreatorProfile("Mia", "bedroom", "Auburn hair.");
const liveState = defaultLiveState("bedroom", {
  top: { on: true, description: "white crop top" },
  bottom: { on: true, description: "grey shorts" },
  bra: { on: true, description: "pink bra" },
  panties: { on: true, description: "pink panties" },
  removedOrder: [],
});

const setup = () => {
  let nowMs = 0;
  const sockets: FakeSocket[] = [];
  let rafCallbacks: (() => void)[] = [];
  const statuses: [string, RequestStatus][] = [];
  const drawn: number[] = [];
  const decoded: FakeFrame[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (frame: FakeFrame) => drawn.push(frame.id),
    }),
  } as unknown as HTMLCanvasElement;
  const composePrompt = vi.fn(async (input: LongLiveComposeInput) => ({
    prompt: input.requestText
      ? `scene for ${input.requestText}`
      : "opening scene",
    settlePrompt: input.requestText
      ? `settle after ${input.requestText}`
      : "settle",
    state: input.state,
    reply: input.requestText ? `ok ${input.requestText}` : null,
  }));
  const deps: LongLiveSessionDeps = {
    fetchTicket: vi.fn(async () => ({
      ticket: `ticket-${sockets.length + 1}`,
      url: "wss://longlive.example",
      expiresAt: 120_000,
    })),
    createWebSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    decodeFrame: vi.fn(async () => {
      const frame = makeFrame();
      decoded.push(frame);
      return frame as unknown as LongLiveFrame;
    }),
    now: () => nowMs,
    requestFrame: (callback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    },
    cancelFrame: () => {
      rafCallbacks = [];
    },
    composePrompt,
    onTranscriptEntry: vi.fn(),
    onRequestStatus: (id, status) => statuses.push([id, status]),
    onLiveState: vi.fn(),
    onStreamState: vi.fn(),
    onFirstFrame: vi.fn(),
    onMetrics: vi.fn(),
    onError: vi.fn(),
    onEnded: vi.fn(),
    captureFrame: vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" })),
    observeWardrobe: vi.fn(),
  };
  const session = new LongLiveSession(deps);
  // Advances the clock and runs one animation frame, like a display refresh.
  const advance = (ms: number) => {
    nowMs += ms;
    const callbacks = rafCallbacks;
    rafCallbacks = [];
    for (const callback of callbacks) callback();
  };
  const openSession = async () => {
    const opened = session.open({
      creator,
      state: liveState,
      referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
      speechMode: "text",
      startedAtMs: 0,
    });
    await flush();
    const socket = sockets[0] as FakeSocket;
    socket.serverOpen();
    socket.serverText({ type: "ready", width: 480, height: 832, fps: 16 });
    await opened;
    return socket;
  };
  const sendFrames = async (socket: FakeSocket, count: number) => {
    for (let i = 0; i < count; i += 1) socket.serverFrame(i);
    // Each frame's decode takes a few microtask hops through the ordered decode chain.
    for (let i = 0; i < count; i += 1) await flush();
  };
  return {
    session,
    deps,
    sockets,
    statuses,
    drawn,
    decoded,
    canvas,
    composePrompt,
    observeWardrobe: deps.observeWardrobe as ReturnType<typeof vi.fn>,
    advance,
    openSession,
    sendFrames,
  };
};

describe("LongLiveSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the socket with the ticket and sends one start carrying the opening prompt", async () => {
    const t = setup();
    const socket = await t.openSession();
    expect(socket.url).toBe("wss://longlive.example/ws?ticket=ticket-1");
    expect(socket.binaryType).toBe("arraybuffer");
    expect(socket.sent).toEqual([
      {
        type: "start",
        referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
        prompt: "opening scene",
        width: 480,
        height: 832,
        fps: 24,
        faceRestore: true,
      },
    ]);
    expect(t.deps.onStreamState).toHaveBeenCalledWith("live");
  });

  it("carries a face restore opt-out in the start message", async () => {
    const t = setup();
    const opened = t.session.open({
      creator,
      state: liveState,
      referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
      speechMode: "text",
      startedAtMs: 0,
      faceRestore: false,
    });
    await flush();
    const socket = t.sockets[0] as FakeSocket;
    socket.serverOpen();
    socket.serverText({ type: "ready", width: 480, height: 832, fps: 16 });
    await opened;
    expect(socket.sent[0]).toMatchObject({ type: "start", faceRestore: false });
  });

  it("decodes binary frames and paints them onto the canvas at the stream fps", async () => {
    const t = setup();
    const socket = await t.openSession();
    t.session.attachCanvas(t.canvas);
    await t.sendFrames(socket, 20);
    t.advance(16);
    expect(t.deps.onFirstFrame).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 60; i += 1) t.advance(16);
    // About a second of 60 Hz refreshes paints about 16 frames.
    expect(t.drawn.length).toBeGreaterThanOrEqual(14);
    expect(t.drawn.length).toBeLessThanOrEqual(18);
    expect(t.canvas.width).toBe(480);
    expect(t.canvas.height).toBe(832);
  });

  it("repaints the last frame onto a canvas attached later, so it never starts black", async () => {
    const t = setup();
    const socket = await t.openSession();
    await t.sendFrames(socket, 1);
    t.advance(16);
    expect(t.drawn).toEqual([]);
    t.session.attachCanvas(t.canvas);
    expect(t.drawn).toHaveLength(1);
  });

  it("walks a request through queued, generating, playing and done", async () => {
    const t = setup();
    const socket = await t.openSession();
    t.session.request("wave at me", "chat");
    await flush();
    const requestId = t.statuses[0]?.[0] as string;
    expect(t.statuses.map(([, status]) => status)).toEqual([
      "queued",
      "generating",
    ]);
    expect(socket.sent.at(-1)).toEqual({
      type: "prompt",
      prompt: "scene for wave at me",
      id: requestId,
    });
    expect(t.composePrompt.mock.calls[1]?.[0].requestText).toBe("wave at me");

    socket.serverText({ type: "promptApplied", id: requestId, atFrame: 40 });
    expect(t.statuses.at(-1)).toEqual([requestId, "playing"]);

    vi.advanceTimersByTime(LONGLIVE_SETTLE_AFTER_MS);
    const settle = socket.sent.at(-1) as { prompt: string; id: string };
    expect(settle.prompt).toBe("settle after wave at me");
    socket.serverText({ type: "promptApplied", id: settle.id });
    expect(t.statuses.at(-1)).toEqual([requestId, "done"]);
  });

  it("marks a request superseded by a newer one as done and cancels its settle", async () => {
    const t = setup();
    const socket = await t.openSession();
    t.session.request("wave at me", "chat");
    await flush();
    const first = t.statuses[0]?.[0] as string;
    socket.serverText({ type: "promptApplied", id: first });
    t.session.request("spin around", "chat");
    await flush();
    await vi.advanceTimersByTimeAsync(LONGLIVE_MIN_ACTION_MS);
    const second = t.statuses.at(-1)?.[0] as string;
    socket.serverText({ type: "promptApplied", id: second });
    expect(t.statuses).toContainEqual([first, "done"]);
    expect(t.statuses.at(-1)).toEqual([second, "playing"]);
    const sentBefore = socket.sent.length;
    vi.advanceTimersByTime(LONGLIVE_SETTLE_AFTER_MS);
    expect(socket.sent).toHaveLength(sentBefore + 1);
    expect((socket.sent.at(-1) as { prompt: string }).prompt).toBe(
      "settle after spin around",
    );
  });

  it("holds a newer ask until the playing action has had its minimum time", async () => {
    const t = setup();
    const socket = await t.openSession();
    t.session.request("wave at me", "chat");
    await flush();
    socket.serverText({
      type: "promptApplied",
      id: t.statuses[0]?.[0] as string,
    });
    t.session.request("spin around", "chat");
    await flush();
    const sentBefore = socket.sent.length;
    await vi.advanceTimersByTimeAsync(LONGLIVE_MIN_ACTION_MS - 1);
    expect(socket.sent).toHaveLength(sentBefore);
    await vi.advanceTimersByTimeAsync(1);
    expect((socket.sent.at(-1) as { prompt: string }).prompt).toBe(
      "scene for spin around",
    );
  });

  it("confirms an ask sent while connecting once the start that carried it is ready", async () => {
    const t = setup();
    const opened = t.session.open({
      creator,
      state: liveState,
      referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
      speechMode: "text",
      startedAtMs: 0,
    });
    await flush();
    t.session.request("wave at me", "chat");
    await flush();
    const requestId = t.statuses[0]?.[0] as string;
    const socket = t.sockets[0] as FakeSocket;
    socket.serverOpen();
    expect(socket.sent).toEqual([
      expect.objectContaining({
        type: "start",
        prompt: "scene for wave at me",
      }),
    ]);
    socket.serverText({ type: "ready", fps: 16 });
    await opened;
    expect(t.statuses.at(-1)).toEqual([requestId, "playing"]);
  });

  it("fails the request with an in-character line when composing fails", async () => {
    const t = setup();
    const socket = await t.openSession();
    t.composePrompt.mockRejectedValueOnce(new Error("groq down"));
    t.session.request("wave at me", "chat");
    await flush();
    expect(t.statuses.at(-1)?.[1]).toBe("failed");
    expect(socket.sent).toHaveLength(1);
  });

  it("reconnects once on an unexpected close, restarting from the latest prompt and keeping the last frame", async () => {
    const t = setup();
    const socket = await t.openSession();
    t.session.attachCanvas(t.canvas);
    await t.sendFrames(socket, 10);
    for (let i = 0; i < 20; i += 1) t.advance(16);
    t.session.request("wave at me", "chat");
    await flush();
    socket.serverClose(1006);
    expect(t.deps.onStreamState).toHaveBeenCalledWith("reconnecting");
    await flush();
    for (let i = 0; i < 30; i += 1) t.advance(16);
    // Buffer exhausted while reconnecting: painting stops and the canvas keeps the last frame.
    const drawnDuringGap = t.drawn.length;
    for (let i = 0; i < 30; i += 1) t.advance(16);
    expect(t.drawn).toHaveLength(drawnDuringGap);
    const lastDrawn = t.drawn.at(-1);
    expect(t.decoded.find((frame) => frame.id === lastDrawn)?.closed).toBe(
      false,
    );

    const retry = t.sockets[1] as FakeSocket;
    expect(retry.url).toBe("wss://longlive.example/ws?ticket=ticket-2");
    retry.serverOpen();
    expect(retry.sent[0]).toMatchObject({
      type: "start",
      prompt: "scene for wave at me",
    });
    retry.serverText({ type: "ready", fps: 16 });
    const requestId = t.statuses[0]?.[0] as string;
    expect(t.statuses.at(-1)).toEqual([requestId, "playing"]);
    expect(t.session.getMetricsWithCost().reconnects).toBe(1);
    expect(t.deps.onEnded).not.toHaveBeenCalled();

    retry.serverClose(1006);
    expect(t.deps.onEnded).toHaveBeenCalledWith("streamClosed");
    expect(t.sockets).toHaveLength(2);
  });

  it("never reconnects after a ticket or settings rejection", async () => {
    for (const code of [4401, 4400]) {
      const t = setup();
      const socket = await t.openSession();
      socket.serverClose(code);
      await flush();
      expect(t.sockets).toHaveLength(1);
      expect(t.deps.onEnded).toHaveBeenCalledWith("error");
      expect(t.deps.onError).toHaveBeenCalled();
    }
  });

  it("does not reconnect after the server reports an error", async () => {
    const t = setup();
    const socket = await t.openSession();
    socket.serverText({ type: "error", message: "out of memory" });
    socket.serverClose(1011);
    await flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.deps.onError).toHaveBeenCalledWith("out of memory");
    expect(t.deps.onEnded).toHaveBeenCalledWith("error");
  });

  it("rejects open when the socket closes before the stream is ready", async () => {
    const t = setup();
    const opened = t.session.open({
      creator,
      state: liveState,
      referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
      speechMode: "text",
      startedAtMs: 0,
    });
    await flush();
    (t.sockets[0] as FakeSocket).serverClose(1006);
    await expect(opened).rejects.toThrow(/failed to start/);
    expect(t.sockets).toHaveLength(1);
  });

  it("close() sends stop, closes the socket cleanly and releases every bitmap", async () => {
    const t = setup();
    const socket = await t.openSession();
    await t.sendFrames(socket, 5);
    t.advance(16);
    t.session.close();
    expect(socket.sent.at(-1)).toEqual({ type: "stop" });
    expect(socket.closedWith).toBe(1000);
    expect(t.decoded.every((frame) => frame.closed)).toBe(true);
    expect(t.deps.onEnded).toHaveBeenCalledWith("stopped");
    // A close event after our own close must not trigger a reconnect.
    socket.serverClose(1000);
    expect(t.sockets).toHaveLength(1);
  });

  it("bills live time at the H100 rate plus the face restore GPU", async () => {
    const t = setup();
    await t.openSession();
    t.advance(3_600_000);
    expect(t.session.getMetricsWithCost().costUsd).toBeCloseTo(5.95, 5);
  });

  it("bills only the H100 with face restore off", async () => {
    const t = setup();
    const opened = t.session.open({
      creator,
      state: liveState,
      referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
      speechMode: "text",
      startedAtMs: 0,
      faceRestore: false,
    });
    await flush();
    const socket = t.sockets[0] as FakeSocket;
    socket.serverOpen();
    socket.serverText({ type: "ready", width: 480, height: 832, fps: 16 });
    await opened;
    t.advance(3_600_000);
    expect(t.session.getMetricsWithCost().costUsd).toBeCloseTo(4, 5);
  });

  describe("wardrobe persistence", () => {
    const braOff: LiveState = {
      ...liveState,
      wardrobe: {
        ...liveState.wardrobe,
        bra: { on: false, description: "pink bra" },
        removedOrder: ["bra"],
      },
    };

    // Plays "take your bra off" up to its settle point.
    const playBraOff = async (t: ReturnType<typeof setup>) => {
      const socket = await t.openSession();
      t.session.attachCanvas(t.canvas);
      t.composePrompt.mockImplementationOnce(async () => ({
        prompt: "scene for bra off",
        settlePrompt: "settle after bra off",
        state: braOff,
        reply: null,
        wardrobeCheck: ["bra"],
      }));
      t.session.request("take your bra off", "chat");
      await flush();
      const requestId = t.statuses[0]?.[0] as string;
      socket.serverText({ type: "promptApplied", id: requestId });
      return { socket, requestId };
    };

    // Runs every vision poll, then lets the plain settle fire.
    const pollThenSettle = async () => {
      vi.advanceTimersByTime(LONGLIVE_WARDROBE_CHECK_AFTER_MS);
      await flush();
      for (let i = 1; i < LONGLIVE_WARDROBE_CHECK_ATTEMPTS; i += 1) {
        vi.advanceTimersByTime(LONGLIVE_WARDROBE_CHECK_EVERY_MS);
        await flush();
      }
      vi.advanceTimersByTime(
        LONGLIVE_SETTLE_AFTER_MS -
          LONGLIVE_WARDROBE_CHECK_AFTER_MS -
          (LONGLIVE_WARDROBE_CHECK_ATTEMPTS - 1) *
            LONGLIVE_WARDROBE_CHECK_EVERY_MS,
      );
      await flush();
    };

    it("confirms the change on the canvas frame, re-anchors, then settles naming what she wears", async () => {
      const t = setup();
      const { socket } = await playBraOff(t);
      t.observeWardrobe.mockResolvedValue({
        confirmed: true,
        seen: true,
        state: braOff,
        settlePrompt: "settle, topless",
      });
      // Checked early, while the removal is still on screen, not at the 12 s settle.
      vi.advanceTimersByTime(LONGLIVE_WARDROBE_CHECK_AFTER_MS);
      await flush();
      expect(t.deps.captureFrame).toHaveBeenCalledWith(t.canvas);
      expect(t.observeWardrobe.mock.calls[0]?.[0]).toMatchObject({
        garments: ["bra"],
        state: braOff,
        referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
      });
      expect(socket.sent.slice(-2)).toEqual([
        { type: "reanchor", id: expect.any(String) },
        { type: "prompt", prompt: "settle, topless", id: expect.any(String) },
      ]);
      expect(t.deps.onLiveState).toHaveBeenLastCalledWith(braOff);
      const sent = socket.sent.length;
      vi.advanceTimersByTime(LONGLIVE_SETTLE_AFTER_MS);
      await flush();
      // The plain settle is cancelled, so the named one is the only settle.
      expect(socket.sent).toHaveLength(sent);
      t.session.request("wave at me", "chat");
      await flush();
      expect(t.composePrompt.mock.calls.at(-1)?.[0].wardrobeObserved).toBe(
        true,
      );
    });

    it("neither re-anchors nor asserts a change vision did not see", async () => {
      const t = setup();
      const { socket } = await playBraOff(t);
      t.observeWardrobe.mockResolvedValue({
        confirmed: false,
        seen: false,
        state: liveState,
        settlePrompt: null,
      });
      await pollThenSettle();
      expect(t.observeWardrobe).toHaveBeenCalledTimes(
        LONGLIVE_WARDROBE_CHECK_ATTEMPTS,
      );
      expect(socket.sent.some((m) => m.type === "reanchor")).toBe(false);
      expect(socket.sent.at(-1)).toMatchObject({
        type: "prompt",
        prompt: "settle after bra off",
      });
      // The reconciled state is what the next ask plans from.
      expect(t.deps.onLiveState).toHaveBeenLastCalledWith(liveState);
      t.session.request("wave at me", "chat");
      await flush();
      const next = t.composePrompt.mock.calls.at(-1)?.[0];
      expect(next?.wardrobeObserved).toBe(false);
      expect(next?.state).toEqual(liveState);
    });

    it("settles unchanged when the frame cannot be checked", async () => {
      const t = setup();
      const { socket } = await playBraOff(t);
      t.observeWardrobe.mockRejectedValue(new Error("vision down"));
      await pollThenSettle();
      expect(socket.sent.some((m) => m.type === "reanchor")).toBe(false);
      expect(socket.sent.at(-1)).toMatchObject({
        prompt: "settle after bra off",
      });
    });

    it("keeps polling until the removal shows, then settles named", async () => {
      const t = setup();
      const { socket } = await playBraOff(t);
      const notYet = {
        confirmed: false,
        seen: false,
        state: liveState,
        settlePrompt: null,
      };
      t.observeWardrobe.mockResolvedValueOnce(notYet).mockResolvedValueOnce({
        confirmed: true,
        seen: true,
        state: braOff,
        settlePrompt: "settle, topless",
      });
      vi.advanceTimersByTime(LONGLIVE_WARDROBE_CHECK_AFTER_MS);
      await flush();
      // A mid-removal miss neither reconciles nor settles yet.
      expect(t.deps.onLiveState).not.toHaveBeenLastCalledWith(liveState);
      expect(socket.sent.some((m) => m.type === "reanchor")).toBe(false);
      vi.advanceTimersByTime(LONGLIVE_WARDROBE_CHECK_EVERY_MS);
      await flush();
      expect(socket.sent.slice(-2)).toEqual([
        { type: "reanchor", id: expect.any(String) },
        { type: "prompt", prompt: "settle, topless", id: expect.any(String) },
      ]);
    });

    it("drops the check when a newer ask takes over while vision is reading", async () => {
      const t = setup();
      const { socket } = await playBraOff(t);
      let resolve: (value: unknown) => void = () => undefined;
      t.observeWardrobe.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      vi.advanceTimersByTime(LONGLIVE_WARDROBE_CHECK_AFTER_MS);
      await flush();
      t.session.request("spin around", "chat");
      await flush();
      await vi.advanceTimersByTimeAsync(LONGLIVE_MIN_ACTION_MS);
      const second = t.statuses.at(-1)?.[0] as string;
      socket.serverText({ type: "promptApplied", id: second });
      const sentBefore = socket.sent.length;
      resolve({
        confirmed: true,
        seen: true,
        state: braOff,
        settlePrompt: "settle",
      });
      await flush();
      expect(socket.sent).toHaveLength(sentBefore);
    });

    it("never checks an ask that changes no clothing", async () => {
      const t = setup();
      const socket = await t.openSession();
      t.session.attachCanvas(t.canvas);
      t.session.request("wave at me", "chat");
      await flush();
      socket.serverText({
        type: "promptApplied",
        id: t.statuses[0]?.[0] as string,
      });
      vi.advanceTimersByTime(LONGLIVE_SETTLE_AFTER_MS);
      await flush();
      expect(t.deps.captureFrame).not.toHaveBeenCalled();
      expect(socket.sent.at(-1)).toMatchObject({
        prompt: "settle after wave at me",
      });
    });

    it("accepts the server's reanchored acknowledgement", async () => {
      const t = setup();
      const socket = await t.openSession();
      socket.serverText({ type: "reanchored", id: "a1", atFrame: 97 });
      expect(t.deps.onError).not.toHaveBeenCalled();
    });
  });

  describe("request parity with clip mode", () => {
    it("passes the request-understanding setting and marks a paid ask", async () => {
      const t = setup();
      const opened = t.session.open({
        creator,
        state: liveState,
        referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
        speechMode: "text",
        startedAtMs: 0,
        intentParser: "hybrid",
      });
      await flush();
      const socket = t.sockets[0] as FakeSocket;
      socket.serverOpen();
      socket.serverText({ type: "ready", fps: 24 });
      await opened;
      t.session.request("wave at me", "chat", true);
      await flush();
      expect(t.composePrompt.mock.calls.at(-1)?.[0].intentParser).toBe(
        "hybrid",
      );
      expect(t.deps.onTranscriptEntry).toHaveBeenCalledWith(
        expect.objectContaining({ role: "fan", paid: true }),
      );
    });

    it("checks in once after a quiet stretch, and a new ask resets it", async () => {
      const t = setup();
      const socket = await t.openSession();
      vi.advanceTimersByTime(LIVE_TUNABLES.CHECK_IN_AFTER_IDLE_MS);
      await flush();
      const checkIn = t.composePrompt.mock.calls.at(-1)?.[0];
      expect(checkIn?.checkIn).toBe(true);
      expect(socket.sent.at(-1)).toMatchObject({
        type: "prompt",
        prompt: "opening scene",
      });
      vi.advanceTimersByTime(LONGLIVE_SETTLE_AFTER_MS);
      expect(socket.sent.at(-1)).toMatchObject({ prompt: "settle" });
      const composed = t.composePrompt.mock.calls.length;
      vi.advanceTimersByTime(LIVE_TUNABLES.CHECK_IN_AFTER_IDLE_MS);
      await flush();
      expect(t.composePrompt.mock.calls).toHaveLength(composed);

      t.session.request("wave at me", "chat");
      await flush();
      socket.serverText({
        type: "promptApplied",
        id: t.statuses[0]?.[0] as string,
      });
      vi.advanceTimersByTime(LONGLIVE_SETTLE_AFTER_MS);
      socket.serverText({
        type: "promptApplied",
        id: (socket.sent.at(-1) as { id: string }).id,
      });
      vi.advanceTimersByTime(LIVE_TUNABLES.CHECK_IN_AFTER_IDLE_MS);
      await flush();
      expect(t.composePrompt.mock.calls.at(-1)?.[0].checkIn).toBe(true);
    });
  });
});
