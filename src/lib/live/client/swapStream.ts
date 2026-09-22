// Swap mode: our self-hosted identity swap (services/swap) over the turbo clip pipeline's output.
// Same shape as Lucy mode but the transport is JPEG frames over a plain WebSocket, not WebRTC.
import { LIVE_TUNABLES } from "@/lib/live/contract";

// Same canvas size as Lucy's so the hidden driving surface is shared; fps is the capture rate we
// send, bounded further by MAX_INFLIGHT so a slow GPU drops frames instead of building a queue.
export const SWAP_INPUT = { width: 720, height: 1280, fps: 12 } as const;
const MAX_INFLIGHT = 2;
const OPEN_TIMEOUT_MS = 90_000;
const JPEG_QUALITY = 0.8;

export type SwapStreamState = "opening" | "live" | "failed" | "closed";

// "streamClosed" is the server hanging up; "stopped" is our own close(). A 1008 close is the
// service rejecting the reference or token and is reported as an error, never retried.
export type SwapEndReason = "error" | "stopped" | "streamClosed";

export type SwapMetrics = {
  costUsd: number;
  framesSent: number;
  framesReceived: number;
  lastRoundTripMs: number | null;
  serverFrameMs: number | null;
};

// The subset of WebSocket the session uses, so tests can drive it with a fake.
export type SwapSocket = {
  binaryType: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send: (data: string | Blob | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
};

export type SwapFrameSource = {
  // A JPEG of the current driving frame, or null when nothing is drawn yet.
  grab: () => Promise<Blob | null>;
};

export type SwapFrameSink = {
  draw: (frame: Blob) => Promise<void>;
};

export type SwapSessionDeps = {
  fetchSessionUrl: () => Promise<string>;
  openSocket: (url: string) => SwapSocket;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
  onStreamState: (state: SwapStreamState) => void;
  onError: (message: string) => void;
  onEnded: (reason: SwapEndReason) => void;
  onDiagnostic?: (line: string) => void;
};

export type SwapOpenInput = {
  referenceImageUrl: string;
  source: SwapFrameSource;
  sink: SwapFrameSink;
};

type ServerMessage =
  | { type: "ready" }
  | { type: "metrics"; frame_ms: number }
  | { type: "error"; reason: string };

const parseServerMessage = (raw: string): ServerMessage | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      return parsed as ServerMessage;
    }
  } catch {
    // Not JSON; fall through.
  }
  return null;
};

export const openBrowserSwapSocket = (url: string): SwapSocket => {
  const socket = new WebSocket(url);
  socket.binaryType = "blob";
  return socket;
};

export class SwapSession {
  private readonly deps: SwapSessionDeps;
  private socket: SwapSocket | null = null;
  private captureTimer: unknown = null;
  private liveSinceMs: number | null = null;
  private closed = false;
  private inflight = 0;
  private framesSent = 0;
  private framesReceived = 0;
  private lastRoundTripMs: number | null = null;
  private serverFrameMs: number | null = null;
  private readonly sentAt: number[] = [];

  constructor(deps: SwapSessionDeps) {
    this.deps = deps;
  }

  async open(input: SwapOpenInput): Promise<void> {
    const url = await this.deps.fetchSessionUrl();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.deps.onError("Swap stream took too long to open.");
        this.endSession("error");
        reject(new Error("swap open timeout"));
      }, OPEN_TIMEOUT_MS);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      this.deps.onStreamState("opening");
      const socket = this.deps.openSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        socket.send(
          JSON.stringify({ type: "reference", image: input.referenceImageUrl }),
        );
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          const message = parseServerMessage(event.data);
          if (!message) return;
          if (message.type === "ready") {
            this.liveSinceMs = this.deps.now();
            this.deps.onStreamState("live");
            this.startCapture(input.source);
            settle(resolve);
          } else if (message.type === "metrics") {
            this.serverFrameMs = message.frame_ms;
          } else if (message.type === "error") {
            this.deps.onError(message.reason);
          }
          return;
        }
        const sentAt = this.sentAt.shift();
        this.inflight = Math.max(0, this.inflight - 1);
        this.framesReceived += 1;
        if (sentAt !== undefined) {
          this.lastRoundTripMs = this.deps.now() - sentAt;
        }
        const frame =
          event.data instanceof Blob
            ? event.data
            : new Blob([event.data as ArrayBuffer], { type: "image/jpeg" });
        void input.sink.draw(frame).catch((error: unknown) => {
          this.deps.onDiagnostic?.(`sink draw failed: ${String(error)}`);
        });
      };
      socket.onerror = () => {
        this.deps.onDiagnostic?.("socket error");
      };
      socket.onclose = (event) => {
        this.deps.onDiagnostic?.(
          `socket closed code=${event.code} reason=${event.reason || "none"}`,
        );
        if (this.closed) return;
        const failed = event.code === 1008 || event.code === 1011;
        if (failed) {
          this.deps.onError(
            event.reason
              ? `Swap service rejected the stream: ${event.reason}`
              : "Swap service rejected the stream.",
          );
        }
        this.deps.onStreamState(failed ? "failed" : "closed");
        this.endSession(failed ? "error" : "streamClosed");
        settle(() => reject(new Error(`swap stream ${event.code}`)));
      };
    });
  }

  private startCapture(source: SwapFrameSource): void {
    this.captureTimer = this.deps.setInterval(
      () => {
        if (this.closed || !this.socket) return;
        if (this.inflight >= MAX_INFLIGHT) return;
        this.inflight += 1;
        void source
          .grab()
          .then((frame) => {
            if (!frame || this.closed || !this.socket) {
              this.inflight = Math.max(0, this.inflight - 1);
              return;
            }
            this.sentAt.push(this.deps.now());
            this.framesSent += 1;
            this.socket.send(frame);
          })
          .catch(() => {
            this.inflight = Math.max(0, this.inflight - 1);
          });
      },
      Math.round(1000 / SWAP_INPUT.fps),
    );
  }

  getMetricsWithCost(): SwapMetrics {
    const elapsedLiveSec =
      this.liveSinceMs !== null
        ? Math.max(0, (this.deps.now() - this.liveSinceMs) / 1000)
        : 0;
    return {
      costUsd: elapsedLiveSec * LIVE_TUNABLES.SWAP_COST_PER_SEC_USD,
      framesSent: this.framesSent,
      framesReceived: this.framesReceived,
      lastRoundTripMs: this.lastRoundTripMs,
      serverFrameMs: this.serverFrameMs,
    };
  }

  private endSession(reason: SwapEndReason): void {
    if (this.closed) return;
    this.closed = true;
    if (this.captureTimer !== null) {
      this.deps.clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && reason === "stopped") {
      try {
        socket.send(JSON.stringify({ type: "stop" }));
      } catch {
        // Already closing; nothing to flush.
      }
      socket.close(1000, "stopped");
    }
    this.deps.onEnded(reason);
  }

  close(): void {
    this.endSession("stopped");
  }
}

export { JPEG_QUALITY as SWAP_JPEG_QUALITY };
