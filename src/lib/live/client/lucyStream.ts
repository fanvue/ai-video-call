// Lucy mode: a live WebRTC restyle over the turbo clip pipeline's own output (see useLiveSession's
// canvas-capture wiring), NOT a clip backend. Model: decart/lucy-2-5/realtime (video-to-video).
import { fal } from "@fal-ai/client";
import { lucyRealtime } from "@fal-ai/client/realtime";
import { LIVE_TUNABLES } from "@/lib/live/contract";

export const LUCY_ENDPOINT_ID = "decart/lucy-2-5/realtime";

const OPEN_TIMEOUT_MS = 30_000;
// Matches the server's TOKEN_EXPIRATION_SECONDS (lucyToken/route.ts) so the SDK's tokenProvider refresh loop re-mints before the session outlives the token.
const TOKEN_EXPIRATION_SECONDS = 120;

export type LucyRealtimeState = "opening" | "live" | "failed" | "closed";

export type LucyRealtimeHandle = {
  readonly state: LucyRealtimeState;
  readonly ready: Promise<unknown>;
  close: () => void | Promise<void>;
};

export type OpenLucyRealtimeOptions = {
  referenceImageUrl: string;
  prompt: string;
  drivingStream: MediaStream;
  fetchToken: () => Promise<string>;
  onMedia: (stream: MediaStream) => void;
  onState: (state: LucyRealtimeState) => void;
  onError: (error: unknown) => void;
  onDiagnostic?: (line: string) => void;
};

export type OpenLucyRealtime = (
  options: OpenLucyRealtimeOptions,
) => LucyRealtimeHandle;

type RealtimeDiagnosticEvent = {
  kind: string;
  phase?: string;
  message?: string;
  detail?: Record<string, number | string>;
};

const describeDiagnostic = (event: RealtimeDiagnosticEvent): string => {
  const detail = event.detail
    ? " " +
      Object.entries(event.detail)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
  return `${event.kind}${event.phase ? ` ${event.phase}` : ""}${event.message ? ` ${event.message}` : ""}${detail}`;
};

// fal documents reference_image_url as a data URI (min 512x512), so the anchor frame is inlined rather than linked.
export const fetchAsDataUri = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`reference frame fetch failed: ${response.status}`);
  }
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("reference frame read failed"));
    reader.readAsDataURL(blob);
  });
};

// Unlike wma (director), lucy.js never calls context.fetch/run — its token rides the WS URL's fal_jwt_token query param (protocol.js buildRealtimeUrl), not an Authorization header, so the Key-vs-Bearer fix directorStream.ts needed for wma.fal.run's /ice call doesn't apply here.
export const openRealtimeWithFalLucy: OpenLucyRealtime = (options) => {
  const session = fal.realtime.open(lucyRealtime(), {
    endpointId: LUCY_ENDPOINT_ID,
    input: {
      prompt: options.prompt,
      reference_image_url: options.referenceImageUrl,
      enable_prompt_expansion: false,
    },
    localStream: options.drivingStream,
    tokenProvider: () => options.fetchToken(),
    tokenExpirationSeconds: TOKEN_EXPIRATION_SECONDS,
    onMedia: options.onMedia,
    onState: options.onState,
    onError: options.onError,
    onDiagnostic: (event: RealtimeDiagnosticEvent) =>
      options.onDiagnostic?.(describeDiagnostic(event)),
  });
  return session as unknown as LucyRealtimeHandle;
};

export type LucyMetrics = {
  costUsd: number;
};

export type LucyEndReason = "maxDuration" | "error" | "stopped";

export type LucySessionDeps = {
  fetchToken: () => Promise<string>;
  openRealtime: (options: OpenLucyRealtimeOptions) => LucyRealtimeHandle;
  now: () => number;
  onStreamState: (state: LucyRealtimeState) => void;
  onMedia: (stream: MediaStream) => void;
  onError: (message: string) => void;
  onEnded: (reason: LucyEndReason) => void;
  onDiagnostic?: (line: string) => void;
};

export type LucyOpenInput = {
  referenceImageUrl: string;
  prompt: string;
  drivingStream: MediaStream;
};

export class LucySession {
  private readonly deps: LucySessionDeps;
  private handle: LucyRealtimeHandle | null = null;
  private liveSinceMs: number | null = null;
  private closed = false;

  constructor(deps: LucySessionDeps) {
    this.deps = deps;
  }

  async open(input: LucyOpenInput): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.deps.onError("Lucy stream took too long to open.");
        void this.handle?.close();
        this.handle = null;
        reject(new Error("lucy open timeout"));
      }, OPEN_TIMEOUT_MS);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const handle = this.deps.openRealtime({
        referenceImageUrl: input.referenceImageUrl,
        prompt: input.prompt,
        drivingStream: input.drivingStream,
        fetchToken: this.deps.fetchToken,
        onDiagnostic: this.deps.onDiagnostic,
        onMedia: (stream) => this.deps.onMedia(stream),
        onState: (state) => {
          this.deps.onStreamState(state);
          if (state === "live") {
            this.liveSinceMs = this.deps.now();
            settle(resolve);
            return;
          }
          if (state === "failed" || state === "closed") {
            // Reachable both before and after open() settles: a live stream can still die later,
            // and endSession/onEnded must fire either way — only the promise settlement is gated.
            this.endSession(state === "failed" ? "error" : "stopped");
            settle(() => reject(new Error(`lucy stream ${state}`)));
          }
        },
        onError: (error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.deps.onError(message);
          this.endSession("error");
          settle(() =>
            reject(error instanceof Error ? error : new Error(message)),
          );
        },
      });
      this.handle = handle;
    });
  }

  // No documented per-second session minimum for Lucy (unlike director's $1.20 floor), so cost is
  // plain elapsed-time billing; ASSUMED absent a fal doc stating otherwise.
  getMetricsWithCost(): LucyMetrics {
    const elapsedLiveSec =
      this.liveSinceMs !== null
        ? Math.max(0, (this.deps.now() - this.liveSinceMs) / 1000)
        : 0;
    return { costUsd: elapsedLiveSec * LIVE_TUNABLES.LUCY_COST_PER_SEC_USD };
  }

  private endSession(reason: LucyEndReason): void {
    if (this.closed) return;
    this.closed = true;
    const handle = this.handle;
    this.handle = null;
    if (handle) {
      void handle.close();
    }
    this.deps.onEnded(reason);
  }

  close(): void {
    this.endSession("stopped");
  }
}
