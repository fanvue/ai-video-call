import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SwapSession,
  type SwapSessionDeps,
  type SwapSocket,
} from "@/lib/live/client/swapStream";

class FakeSocket implements SwapSocket {
  binaryType = "blob";
  onopen: SwapSocket["onopen"] = null;
  onmessage: SwapSocket["onmessage"] = null;
  onclose: SwapSocket["onclose"] = null;
  onerror: SwapSocket["onerror"] = null;
  sent: (string | Blob | ArrayBuffer)[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];
  send(data: string | Blob | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }
}

const makeDeps = (overrides: Partial<SwapSessionDeps> = {}) => {
  const sockets: FakeSocket[] = [];
  const deps: SwapSessionDeps = {
    fetchSessionUrl: vi.fn().mockResolvedValue("wss://swap.test/ws?token=t"),
    openSocket: vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
    setInterval: vi.fn(() => "timer"),
    clearInterval: vi.fn(),
    now: vi.fn(() => 0),
    onStreamState: vi.fn(),
    onError: vi.fn(),
    onEnded: vi.fn(),
    ...overrides,
  };
  return { deps, sockets };
};

const source = { grab: vi.fn().mockResolvedValue(null) };
const sink = { draw: vi.fn().mockResolvedValue(undefined) };
const input = () => ({
  referenceImageUrl: "data:image/jpeg;base64,AAA",
  source,
  sink,
});

// The session only reads `.data`; a full MessageEvent is not constructible with a Blob in jsdom.
const msg = (data: unknown) => ({ data }) as MessageEvent;
const closeEvent = (code: number, reason: string) =>
  ({ code, reason }) as CloseEvent;
const ready = () => msg(JSON.stringify({ type: "ready" }));

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  source.grab.mockReset().mockResolvedValue(null);
  sink.draw.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SwapSession.open", () => {
  it("sends the reference on open and goes live on ready", async () => {
    const { deps, sockets } = makeDeps();
    const session = new SwapSession(deps);
    const opening = session.open(input());
    await flush();
    const socket = sockets[0];
    socket.onopen?.({} as Event);
    expect(socket.sent[0]).toBe(
      JSON.stringify({
        type: "reference",
        image: "data:image/jpeg;base64,AAA",
      }),
    );
    socket.onmessage?.(ready());
    await opening;
    expect(deps.onStreamState).toHaveBeenLastCalledWith("live");
    expect(deps.setInterval).toHaveBeenCalledTimes(1);
  });

  it("reports a 1008 close as an error and never reopens", async () => {
    const { deps, sockets } = makeDeps();
    const session = new SwapSession(deps);
    const opening = session.open(input());
    await flush();
    const assertion = expect(opening).rejects.toThrow("1008");
    sockets[0].onclose?.(closeEvent(1008, "bad reference"));
    await assertion;
    expect(deps.onError).toHaveBeenCalledWith(
      "Swap service rejected the stream: bad reference",
    );
    expect(deps.onEnded).toHaveBeenCalledWith("error");
    expect(deps.openSocket).toHaveBeenCalledTimes(1);
  });

  it("reports a clean server close of a live stream as streamClosed", async () => {
    const { deps, sockets } = makeDeps();
    const session = new SwapSession(deps);
    const opening = session.open(input());
    await flush();
    sockets[0].onmessage?.(ready());
    await opening;
    sockets[0].onclose?.(closeEvent(1000, ""));
    expect(deps.onEnded).toHaveBeenCalledWith("streamClosed");
    expect(deps.clearInterval).toHaveBeenCalledWith("timer");
  });
});

describe("SwapSession frames", () => {
  it("tracks round trip and server frame time and draws every returned frame", async () => {
    let nowMs = 0;
    const { deps, sockets } = makeDeps({ now: () => nowMs });
    const session = new SwapSession(deps);
    const opening = session.open(input());
    await flush();
    const socket = sockets[0];
    socket.onmessage?.(ready());
    await opening;

    const tick = vi.mocked(deps.setInterval).mock.calls[0][0];
    const frame = new Blob(["x"], { type: "image/jpeg" });
    source.grab.mockResolvedValueOnce(frame);
    tick();
    await flush();
    expect(socket.sent).toContain(frame);

    nowMs = 400;
    socket.onmessage?.(msg(JSON.stringify({ type: "metrics", frame_ms: 55 })));
    socket.onmessage?.(msg(new Blob(["y"], { type: "image/jpeg" })));
    await flush();
    const metrics = session.getMetricsWithCost();
    expect(metrics.framesSent).toBe(1);
    expect(metrics.framesReceived).toBe(1);
    expect(metrics.lastRoundTripMs).toBe(400);
    expect(metrics.serverFrameMs).toBe(55);
    expect(sink.draw).toHaveBeenCalledTimes(1);
  });

  it("skips grabbing when two frames are already in flight", async () => {
    const { deps, sockets } = makeDeps();
    const session = new SwapSession(deps);
    const opening = session.open(input());
    await flush();
    sockets[0].onmessage?.(ready());
    await opening;
    const tick = vi.mocked(deps.setInterval).mock.calls[0][0];
    source.grab.mockResolvedValue(new Blob(["x"]));
    tick();
    tick();
    tick();
    await flush();
    expect(source.grab).toHaveBeenCalledTimes(2);
  });
});

describe("SwapSession.close", () => {
  it("sends stop, closes the socket once and reports stopped", async () => {
    const { deps, sockets } = makeDeps();
    const session = new SwapSession(deps);
    const opening = session.open(input());
    await flush();
    sockets[0].onmessage?.(ready());
    await opening;
    session.close();
    session.close();
    expect(sockets[0].sent).toContain(JSON.stringify({ type: "stop" }));
    expect(sockets[0].closeCalls).toEqual([{ code: 1000, reason: "stopped" }]);
    expect(deps.onEnded).toHaveBeenCalledTimes(1);
    expect(deps.onEnded).toHaveBeenCalledWith("stopped");
  });
});
