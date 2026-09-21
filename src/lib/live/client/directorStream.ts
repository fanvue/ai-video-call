// Director mode: a persistent WebRTC live stream (fal minimax/h3-max/director), NOT a clip backend.
import { fal } from "@fal-ai/client";
import { wma } from "@fal-ai/client/realtime";
import { z } from "zod";
import {
  LIVE_TUNABLES,
  type CreatorProfile,
  type InputChannel,
  type SpeechMode,
  type TranscriptEntry,
  type Wardrobe,
} from "@/lib/live/contract";
import type { RequestStatus } from "@/lib/live/client/director";

export const DIRECTOR_ENDPOINT_ID = "minimax/h3-max/director";

const CONFIGURE_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = 1;
// The clip backends render 9:16; match it so the live stream fills the same player chrome.
const ASPECT_RATIO = "9:16";
const RESOLUTION = "480p";
// Prior segment prompts the model's expander keeps as context (fal: 1-50, default 12). High so the opening premise (her look, the room) keeps steering long after many fan requests.
const MEMORY_SEGMENTS = 40;

// fal's own $1.20 session-minimum charge, regardless of duration.
const SESSION_MINIMUM_USD = 1.2;

// ---- server -> client protocol (fal endpoint AsyncAPI, protocol_version 1) ----

// reason/code enums are deliberately open strings: a closed enum would drop an unknown value's whole message, and a dropped `error` or `prompt_rejected` fails open.
const knownServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("configured"),
    chunk_duration: z.number().optional(),
    memory: z.number().optional(),
    has_initial_image: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("prompt_pending"),
    prompt_version: z.number().optional(),
  }),
  z.object({
    type: z.literal("prompt_applied"),
    prompt_version: z.number().optional(),
  }),
  z.object({
    type: z.literal("prompt_rejected"),
    prompt_version: z.number().optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("chunk"),
    chunk_index: z.number().optional(),
    prompt_version: z.number().optional(),
    generation_seconds: z.number().optional(),
    playback_seconds: z.number().optional(),
    buffer_depth_seconds: z.number().optional(),
    scheduling_lead_ms: z.number().optional(),
    scheduling_slack_ms: z.number().optional(),
    next_generation_estimate_seconds: z.number().optional(),
  }),
  z.object({ type: z.literal("chunk_metrics") }).passthrough(),
  z.object({
    type: z.literal("session_metrics"),
    phases: z
      .record(
        z.string(),
        z.object({
          p50_ms: z.number().optional(),
          p95_ms: z.number().optional(),
        }),
      )
      .optional(),
  }),
  z.object({
    type: z.literal("deadline_missed"),
    late_by_seconds: z.number().optional(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("stream_exhausted"),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal("session_info") }).passthrough(),
  z.object({ type: z.literal("pong"), ts: z.number().optional() }),
]);

// A message with an unrecognized `type` simply fails this parse and is dropped by the caller's
// safeParse check below — ignored, not thrown, per the protocol's own forward-compat contract.
const serverMessageSchema = knownServerMessageSchema;
type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---- client -> server protocol ----

type ConfigureMessage = {
  type: "configure";
  prompt_version: 1;
  prompt: string;
  resolution: typeof RESOLUTION;
  aspect_ratio: typeof ASPECT_RATIO;
  memory?: number;
  image_url?: string;
  end_image_url?: string;
  protocol_version: typeof PROTOCOL_VERSION;
};
type PromptMessage = {
  type: "prompt";
  prompt_version: number;
  prompt: string;
  replan: boolean;
};
type StopMessage = { type: "stop" };

// ---- realtime transport seam (injected so this class is testable without the real fal SDK) ----

export type DirectorRealtimeState = "opening" | "live" | "failed" | "closed";

export type DirectorRealtimeHandle = {
  readonly state: DirectorRealtimeState;
  readonly ready: Promise<unknown>;
  send: (message: ConfigureMessage | PromptMessage | StopMessage) => void;
  close: () => void | Promise<void>;
};

export type RealtimeDiagnosticEvent = {
  kind: string;
  phase?: string;
  message?: string;
  detail?: Record<string, number | string>;
};

export type OpenRealtimeOptions = {
  endpointId: string;
  receive: readonly ("audio" | "video")[];
  onMedia: (stream: MediaStream) => void;
  onData: (raw: string) => void;
  onState: (state: DirectorRealtimeState) => void;
  onError: (error: unknown) => void;
  onDiagnostic?: (event: RealtimeDiagnosticEvent) => void;
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

export type OpenRealtime = (
  options: OpenRealtimeOptions,
) => DirectorRealtimeHandle;

// wma.fal.run takes neither the SDK's `Key <temporary jwt>` ("unsupported auth scheme") nor `Bearer` with a rest.fal.ai token ("unable to decode issuer"), only the real key; so signalling goes through our auth-gated proxy, which adds it server-side.
export const FAL_PROXY_PATH = "/api/fal/proxy";

export const openRealtimeWithFal = (): OpenRealtime => {
  return (options) => {
    fal.config({ credentials: undefined, proxyUrl: FAL_PROXY_PATH });
    const session = fal.realtime.open(wma(DIRECTOR_ENDPOINT_ID), {
      receive: options.receive,
      onMedia: options.onMedia,
      onData: options.onData,
      onState: options.onState,
      onError: options.onError,
      onDiagnostic: options.onDiagnostic,
    });
    return session as unknown as DirectorRealtimeHandle;
  };
};

const garmentsWorn = (wardrobe: Wardrobe): string => {
  const worn = (["top", "bottom", "bra", "panties"] as const)
    .filter((id) => wardrobe[id].on)
    .map((id) => wardrobe[id].description.trim())
    .filter((description) => description.length > 0);
  return worn.length > 0 ? worn.join(", ") : "nothing";
};

// The session premise: fal's guidance is genre + visual language + what never changes + an action already underway, not a synopsis. Every later prompt is expanded against this.
export const buildDirectorPremise = (input: {
  lookLock: string;
  wardrobe: Wardrobe;
  surroundings: string;
  world: string;
  speechMode: SpeechMode;
}): string =>
  [
    "A continuous, uncut, real-time solo webcam livestream, shot on a fixed phone camera in portrait. One adult woman, alone, live for her viewers.",
    "TONE: she is warm, flirty and playful, chatting with her viewers and doing what they ask, one request at a time.",
    `LOOK LOCK: ${input.lookLock} Preserve her face, hair, skin and body exactly for the whole stream. Do not beautify, slim, age, or swap her. One person only, no one else ever enters.`,
    `WEARING NOW: ${garmentsWorn(input.wardrobe)}. Garments only change when a direction says so, one at a time, with real fabric weight; nothing teleports, dissolves or regrows.`,
    `ROOM: ${input.surroundings} Keep the same room, furniture, lighting and camera position for the whole stream. ${input.world}`,
    "CAMERA: static webcam framing, medium shot, she looks into the lens and talks to her viewers like a live streamer; small natural movements, no cuts, no camera moves, no zooms, no scene changes.",
    input.speechMode === "native"
      ? "AUDIO: quiet room ambience; she speaks clear everyday English straight to camera, lip-synced word for word to any line given in quotes."
      : "AUDIO: quiet room ambience only. She does not speak; lips relaxed, no mouthing words.",
    "No text overlays, no watermark, no subtitles, no UI.",
    "NOW: she has just gone live, settles into frame, smiles at the camera and greets her viewers.",
  ].join(" ");

// ---- public session state for the UI ----

export type DirectorMetrics = {
  chunkCount: number;
  bufferDepthSec: number | null;
  lastSchedulingSlackMs: number | null;
  deadlineMissedCount: number;
  sessionMetrics: Record<string, { p50Ms?: number; p95Ms?: number }> | null;
  costUsd: number;
};

export type DirectorEndReason =
  "maxDuration" | "streamExhausted" | "error" | "stopped";

export type DirectorSessionDeps = {
  openRealtime: () => OpenRealtime;
  now: () => number;
  composePrompt: (input: {
    creator: CreatorProfile;
    transcript: TranscriptEntry[];
    world: string;
    requestText: string;
    channel: InputChannel;
    speechMode: SpeechMode;
  }) => Promise<{ prompt: string; reply: string }>;
  onTranscriptEntry: (entry: TranscriptEntry) => void;
  onRequestStatus: (requestId: string, status: RequestStatus) => void;
  onStreamState: (state: DirectorRealtimeState) => void;
  onMedia: (stream: MediaStream) => void;
  onMetrics: (metrics: DirectorMetrics) => void;
  onError: (message: string) => void;
  onEnded: (reason: DirectorEndReason) => void;
  // Transport progress lines (ICE, connection state, control channel) for the console and failure messages.
  onDiagnostic?: (line: string) => void;
};

export type DirectorOpenInput = {
  creator: CreatorProfile;
  world: string;
  surroundings: string;
  wardrobe: Wardrobe;
  anchorFrameUrl: string;
  speechMode: SpeechMode;
  startedAtMs: number;
};

const FAILURE_LINES = [
  "ugh, that one glitched on me, ask me again?",
  "hmm, my stream hiccuped, say that again?",
];

type PendingRequest = { requestId: string; status: "generating" };

export class DirectorSession {
  private readonly deps: DirectorSessionDeps;
  private handle: DirectorRealtimeHandle | null = null;
  private creator: CreatorProfile | null = null;
  private world = "";
  private speechMode: SpeechMode = "text";
  private startedAtMs = 0;
  private liveSinceMs: number | null = null;
  private transcript: TranscriptEntry[] = [];
  private idCounter = 0;
  private nextPromptVersion = 1;
  // version -> the request it belongs to, while the server hasn't confirmed a terminal outcome yet.
  private pendingByVersion = new Map<number, PendingRequest>();
  private sendQueue: Promise<void> = Promise.resolve();
  private configureTimer: ReturnType<typeof setTimeout> | null = null;
  private maxSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private failureCount = 0;
  private metrics: DirectorMetrics = {
    chunkCount: 0,
    bufferDepthSec: null,
    lastSchedulingSlackMs: null,
    deadlineMissedCount: 0,
    sessionMetrics: null,
    costUsd: 0,
  };

  constructor(deps: DirectorSessionDeps) {
    this.deps = deps;
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `director-${prefix}-${this.idCounter}`;
  }

  private elapsedSec(): number {
    return Math.max(0, Math.floor((this.deps.now() - this.startedAtMs) / 1000));
  }

  private emitMetrics(): void {
    this.deps.onMetrics({ ...this.metrics });
  }

  private handleData = (raw: string): void => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = serverMessageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return;
    }
    this.handleMessage(parsed.data);
  };

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "prompt_applied": {
        const version = message.prompt_version;
        const pending =
          version !== undefined
            ? this.pendingByVersion.get(version)
            : undefined;
        if (pending) {
          this.deps.onRequestStatus(pending.requestId, "generating");
        }
        return;
      }
      case "prompt_rejected": {
        const version = message.prompt_version;
        const pending =
          version !== undefined
            ? this.pendingByVersion.get(version)
            : undefined;
        if (pending) {
          this.pendingByVersion.delete(version as number);
          this.deps.onRequestStatus(pending.requestId, "failed");
          this.pushFailureLine();
        }
        return;
      }
      case "chunk": {
        this.metrics = {
          ...this.metrics,
          chunkCount: this.metrics.chunkCount + 1,
          bufferDepthSec:
            message.buffer_depth_seconds ?? this.metrics.bufferDepthSec,
          lastSchedulingSlackMs:
            message.scheduling_slack_ms ?? this.metrics.lastSchedulingSlackMs,
        };
        this.emitMetrics();
        const chunkVersion = message.prompt_version;
        if (chunkVersion !== undefined) {
          for (const [version, pending] of this.pendingByVersion) {
            if (version <= chunkVersion) {
              this.deps.onRequestStatus(pending.requestId, "playing");
              this.pendingByVersion.delete(version);
            }
          }
        }
        return;
      }
      case "session_metrics": {
        if (!message.phases) return;
        const sessionMetrics: Record<
          string,
          { p50Ms?: number; p95Ms?: number }
        > = {};
        for (const [phase, stats] of Object.entries(message.phases)) {
          sessionMetrics[phase] = { p50Ms: stats.p50_ms, p95Ms: stats.p95_ms };
        }
        this.metrics = { ...this.metrics, sessionMetrics };
        this.emitMetrics();
        return;
      }
      case "deadline_missed": {
        this.metrics = {
          ...this.metrics,
          deadlineMissedCount: this.metrics.deadlineMissedCount + 1,
        };
        this.emitMetrics();
        return;
      }
      case "stream_exhausted": {
        this.endSession("streamExhausted");
        return;
      }
      case "error": {
        this.deps.onError(
          message.error ?? message.code ?? "director stream error",
        );
        this.endSession("error");
        return;
      }
      default:
        return;
    }
  }

  private pushFailureLine(): void {
    // Modulo a non-empty literal array always yields a defined element; no fallback needed.
    const line = FAILURE_LINES[this.failureCount % FAILURE_LINES.length];
    this.failureCount += 1;
    const entry: TranscriptEntry = {
      id: this.nextId("failure"),
      role: "creator",
      channel: "chat",
      text: line,
      atSec: this.elapsedSec(),
    };
    this.transcript = [...this.transcript, entry];
    this.deps.onTranscriptEntry(entry);
  }

  private startMaxSessionTimer(): void {
    if (this.maxSessionTimer) return;
    this.maxSessionTimer = setTimeout(() => {
      this.endSession("maxDuration");
    }, LIVE_TUNABLES.MAX_SESSION_MS);
  }

  private clearTimers(): void {
    if (this.configureTimer) {
      clearTimeout(this.configureTimer);
      this.configureTimer = null;
    }
    if (this.maxSessionTimer) {
      clearTimeout(this.maxSessionTimer);
      this.maxSessionTimer = null;
    }
  }

  async open(input: DirectorOpenInput): Promise<void> {
    this.creator = input.creator;
    this.world = input.world;
    this.speechMode = input.speechMode;
    this.startedAtMs = input.startedAtMs;

    const openRealtime = this.deps.openRealtime();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this.configureTimer) {
          clearTimeout(this.configureTimer);
          this.configureTimer = null;
        }
        fn();
      };

      let lastDiagnostic = "";
      let lastState: DirectorRealtimeState = "opening";
      const failOpen = (message: string) => {
        settle(() => {
          this.deps.onError(message);
          void this.handle?.close();
          this.handle = null;
          reject(new Error(message));
        });
      };

      this.configureTimer = setTimeout(() => {
        failOpen(
          `Director stream took too long to configure (transport ${lastState}${lastDiagnostic ? `, last: ${lastDiagnostic}` : ""}).`,
        );
      }, CONFIGURE_TIMEOUT_MS);

      const handle = openRealtime({
        endpointId: DIRECTOR_ENDPOINT_ID,
        receive: ["video", "audio"],
        onMedia: (stream) => this.deps.onMedia(stream),
        onData: (raw) => {
          if (!settled) {
            let parsedJson: unknown;
            try {
              parsedJson = JSON.parse(raw);
            } catch {
              return;
            }
            const parsed = serverMessageSchema.safeParse(parsedJson);
            if (parsed.success && parsed.data.type === "configured") {
              this.liveSinceMs = this.deps.now();
              this.startMaxSessionTimer();
              settle(resolve);
              return;
            }
            // A refusal of the opening configure is the real reason the stream never starts; surface it now instead of waiting for the timeout.
            if (parsed.success && parsed.data.type === "error") {
              failOpen(
                `Director rejected the stream: ${parsed.data.error ?? parsed.data.code ?? "unknown error"}`,
              );
              return;
            }
            if (parsed.success && parsed.data.type === "prompt_rejected") {
              failOpen(
                `Director rejected the opening prompt: ${parsed.data.reason ?? parsed.data.error ?? "unknown reason"}`,
              );
              return;
            }
          }
          this.handleData(raw);
        },
        onDiagnostic: (event) => {
          lastDiagnostic = describeDiagnostic(event);
          this.deps.onDiagnostic?.(lastDiagnostic);
        },
        onState: (state) => {
          lastState = state;
          this.deps.onStreamState(state);
        },
        onError: (error) => {
          settle(() => {
            this.deps.onError(
              error instanceof Error ? error.message : String(error),
            );
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        },
      });
      this.handle = handle;

      handle.ready
        .then(() => {
          const configureMessage: ConfigureMessage = {
            type: "configure",
            prompt_version: 1,
            prompt: buildDirectorPremise({
              lookLock: input.creator.lookLock,
              wardrobe: input.wardrobe,
              surroundings: input.surroundings,
              world: input.world,
              speechMode: input.speechMode,
            }),
            resolution: RESOLUTION,
            aspect_ratio: ASPECT_RATIO,
            memory: MEMORY_SEGMENTS,
            image_url: input.anchorFrameUrl,
            protocol_version: PROTOCOL_VERSION,
          };
          handle.send(configureMessage);
        })
        .catch((error: unknown) => {
          settle(() => {
            this.deps.onError(
              error instanceof Error ? error.message : String(error),
            );
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        });
    });
  }

  // Fan/viewer steering request. Queued so concurrent calls still send strictly-increasing
  // prompt_versions to the wire in the order they were made, even though composePrompt is async.
  request(text: string, channel: InputChannel): void {
    const trimmed = text.trim();
    if (!trimmed || !this.handle || this.closed) return;
    const creator = this.creator;
    if (!creator) return;

    const entry: TranscriptEntry = {
      id: this.nextId("fan"),
      role: "fan",
      channel,
      text: trimmed,
      atSec: this.elapsedSec(),
    };
    this.transcript = [...this.transcript, entry];
    this.deps.onTranscriptEntry(entry);
    this.deps.onRequestStatus(entry.id, "queued");

    this.sendQueue = this.sendQueue.then(() =>
      this.sendPromptFor(entry, trimmed, channel),
    );
  }

  private async sendPromptFor(
    entry: TranscriptEntry,
    text: string,
    channel: InputChannel,
  ): Promise<void> {
    const handle = this.handle;
    const creator = this.creator;
    if (!handle || !creator || this.closed) return;

    let composed: { prompt: string; reply: string };
    try {
      composed = await this.deps.composePrompt({
        creator,
        transcript: this.transcript,
        world: this.world,
        requestText: text,
        channel,
        speechMode: this.speechMode,
      });
    } catch {
      this.deps.onRequestStatus(entry.id, "failed");
      this.pushFailureLine();
      return;
    }
    if (this.closed) return;

    this.nextPromptVersion += 1;
    const version = this.nextPromptVersion;
    this.pendingByVersion.set(version, {
      requestId: entry.id,
      status: "generating",
    });

    const replyEntry: TranscriptEntry = {
      id: this.nextId("creator"),
      role: "creator",
      channel,
      text: composed.reply,
      atSec: this.elapsedSec(),
    };
    this.transcript = [...this.transcript, replyEntry];
    this.deps.onTranscriptEntry(replyEntry);

    const message: PromptMessage = {
      type: "prompt",
      prompt_version: version,
      prompt: composed.prompt,
      // Append rather than replan: consecutive fan requests must queue in server-side order.
      replan: false,
    };
    handle.send(message);
  }

  getMetricsWithCost(): DirectorMetrics {
    const elapsedLiveSec =
      this.liveSinceMs !== null
        ? Math.max(0, (this.deps.now() - this.liveSinceMs) / 1000)
        : 0;
    const costUsd =
      elapsedLiveSec > 0
        ? Math.max(
            SESSION_MINIMUM_USD,
            elapsedLiveSec * LIVE_TUNABLES.DIRECTOR_COST_PER_SEC_USD,
          )
        : 0;
    return { ...this.metrics, costUsd };
  }

  private endSession(reason: DirectorEndReason): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const handle = this.handle;
    this.handle = null;
    if (handle) {
      if (reason !== "error") {
        handle.send({ type: "stop" });
      }
      void handle.close();
    }
    this.deps.onEnded(reason);
  }

  close(): void {
    this.endSession("stopped");
  }
}
