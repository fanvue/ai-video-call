// LongLive mode: one uncut stream generated live on our own Modal H100 (services/longlive), NOT a clip backend.
// JPEG frames arrive over a WebSocket and are painted onto a canvas at the server's fps from a small jitter buffer.
import { z } from "zod";
import {
  LIVE_TUNABLES,
  type CreatorProfile,
  type GarmentId,
  type InputChannel,
  type IntentParser,
  type LiveState,
  type SpeechMode,
  type TranscriptEntry,
} from "@/lib/live/contract";
import type { RequestStatus } from "@/lib/live/client/director";

// Portrait, matching the clip backends' 9:16 player chrome.
// 24 fps is the model's native motion rate; asking for 16 played every move at two-thirds speed.
export const LONGLIVE_STREAM = { width: 480, height: 832, fps: 24 } as const;

// A cold container loads the 5B weights onto the H100 before its first block; a warm one answers in seconds.
// Under the 300 s ticket: a cold start is a GPU queue wait plus about 2 min of model load.
const OPEN_TIMEOUT_MS = 290_000;
// Long enough for the asked action to play out before the scene settles back to an idle pose.
export const LONGLIVE_SETTLE_AFTER_MS = 12_000;
// A removal plays 4 to 6 s in, so a newer ask waits this long rather than cut the playing action off mid-move.
export const LONGLIVE_MIN_ACTION_MS = 7_000;
// Measured on Modal: a bra comes off 4 to 6 s after the prompt applies and is back on by about 7 s, so vision reads from 4 s in.
export const LONGLIVE_WARDROBE_CHECK_AFTER_MS = 4_000;
export const LONGLIVE_WARDROBE_CHECK_EVERY_MS = 1_500;
export const LONGLIVE_WARDROBE_CHECK_ATTEMPTS = 4;
// services/longlive closes with these for a bad ticket and a bad start message; retrying cannot fix either.
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_NORMAL = 1000;
// One retry covers a dropped connection without billing a runaway loop of cold starts.
const MAX_RECONNECTS = 1;
const FRAME_HEADER_BYTES = 4;

// ---- jitter buffer and pacing ----

export type PacedFrame = { width: number; height: number; close: () => void };

type PacerOptions = {
  leadSec?: number;
  maxLeadSec?: number;
  maxBufferSec?: number;
};

// Playback rate from how full the buffer is against its lead: a draining buffer plays slower instead of freezing, an overfull one catches up gently.
const rateForFill = (fill: number): number => {
  if (fill < 0.25) return 0.8;
  if (fill < 0.75) return 0.9;
  if (fill > 2.5) return 1.1;
  if (fill > 1.75) return 1.05;
  return 1;
};

export class FramePacer<F extends PacedFrame> {
  private fps: number;
  private leadSec: number;
  private readonly maxLeadSec: number;
  private readonly maxBufferSec: number;
  private queue: F[] = [];
  private current: F | null = null;
  private started = false;
  private starving = false;
  private nextDueAtMs: number | null = null;
  private rate = 1;
  underruns = 0;
  dropped = 0;

  constructor(fps: number, options: PacerOptions = {}) {
    this.fps = fps;
    this.leadSec = options.leadSec ?? 0.5;
    this.maxLeadSec = options.maxLeadSec ?? 1.5;
    this.maxBufferSec = options.maxBufferSec ?? 4;
  }

  setFps(fps: number): void {
    if (fps > 0) this.fps = fps;
  }

  get bufferedFrames(): number {
    return this.queue.length;
  }

  get playbackRate(): number {
    return this.rate;
  }

  get leadFrames(): number {
    return Math.max(1, Math.round(this.leadSec * this.fps));
  }

  get lastFrame(): F | null {
    return this.current;
  }

  push(frame: F): void {
    this.queue.push(frame);
    const maxFrames = Math.round(this.maxBufferSec * this.fps);
    // Safety valve only (the server already applies backpressure): a long-hidden tab must not replay minutes of backlog.
    while (this.queue.length > maxFrames) {
      this.queue.shift()?.close();
      this.dropped += 1;
    }
  }

  // Returns the frame to paint now, or null to keep the canvas on the frame already there; never an empty frame.
  tick(nowMs: number): F | null {
    if (!this.started) {
      if (this.queue.length === 0) return null;
      if (this.queue.length >= this.leadFrames) {
        this.started = true;
        this.nextDueAtMs = nowMs;
      } else if (this.current) {
        return null;
      } else {
        // The very first frame shows at once, so the viewer sees her while the lead fills.
        return this.show(this.queue.shift() as F);
      }
    }
    if (this.nextDueAtMs === null || nowMs < this.nextDueAtMs) return null;
    const next = this.queue.shift();
    if (!next) {
      if (!this.starving) {
        this.starving = true;
        this.underruns += 1;
        // Each dry spell earns a deeper lead, so a jittery connection settles instead of stuttering.
        this.leadSec = Math.min(this.maxLeadSec, this.leadSec + 0.25);
      }
      this.nextDueAtMs = nowMs;
      return null;
    }
    this.starving = false;
    this.rate = rateForFill(this.queue.length / this.leadFrames);
    const intervalMs = 1000 / (this.fps * this.rate);
    this.nextDueAtMs += intervalMs;
    // After a stall (hidden tab, slow paint) resume from now rather than bursting through the backlog.
    if (this.nextDueAtMs < nowMs - intervalMs) this.nextDueAtMs = nowMs;
    return this.show(next);
  }

  private show(frame: F): F {
    // The canvas keeps the old pixels once painted, so the previous bitmap can go.
    this.current?.close();
    this.current = frame;
    return frame;
  }

  dispose(): void {
    for (const frame of this.queue) frame.close();
    this.queue = [];
    this.current?.close();
    this.current = null;
  }
}

// ---- server -> client protocol ----

const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    width: z.number().optional(),
    height: z.number().optional(),
    fps: z.number().optional(),
    loadMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("promptApplied"),
    id: z.string(),
    atFrame: z.number().optional(),
  }),
  z.object({
    type: z.literal("stats"),
    genFps: z.number().optional(),
    blockMs: z.number().optional(),
    decodeMs: z.number().optional(),
    queueFrames: z.number().optional(),
  }),
  z.object({
    type: z.literal("reanchored"),
    id: z.string(),
    atFrame: z.number().optional(),
  }),
  z.object({ type: z.literal("error"), message: z.string().optional() }),
]);
type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---- injected seams ----

// The subset of the browser WebSocket this session uses, so tests can drive it without a server.
export type WebSocketLike = {
  binaryType: string;
  readonly readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

const WS_OPEN = 1;

export type LongLiveFrame = PacedFrame & CanvasImageSource;

export type LongLiveTicket = { ticket: string; url: string; expiresAt: number };

export type LongLiveComposeInput = {
  creator: CreatorProfile;
  state: LiveState;
  transcript: TranscriptEntry[];
  // Absent for the opening prompt.
  requestText?: string;
  channel: InputChannel;
  speechMode: SpeechMode;
  intentParser?: IntentParser;
  // True once the clothing in `state` has been seen on the stream, so prompts may name it.
  wardrobeObserved: boolean;
  checkIn?: boolean;
};

export type LongLiveComposed = {
  prompt: string;
  settlePrompt: string;
  state: LiveState;
  reply: string | null;
  // Garments the prompt changes; confirmed by vision at the settle point.
  wardrobeCheck?: GarmentId[];
};

export type LongLiveObserveInput = {
  creator: CreatorProfile;
  state: LiveState;
  garments: GarmentId[];
  frame: Blob;
  referenceImageUrl: string;
};

export type LongLiveObservation = {
  confirmed: boolean;
  seen: boolean;
  state: LiveState;
  settlePrompt: string | null;
};

export type LongLiveStreamState =
  "opening" | "live" | "reconnecting" | "failed" | "closed";

export type LongLiveEndReason =
  "maxDuration" | "error" | "stopped" | "streamClosed";

export type LongLiveMetrics = {
  genFps: number | null;
  blockMs: number | null;
  decodeMs: number | null;
  serverQueueFrames: number | null;
  bufferedFrames: number;
  playbackRate: number;
  underruns: number;
  droppedFrames: number;
  framesPainted: number;
  reconnects: number;
  loadMs: number | null;
  firstFrameMs: number | null;
  costUsd: number;
};

export type LongLiveSessionDeps = {
  fetchTicket: () => Promise<LongLiveTicket>;
  createWebSocket: (url: string) => WebSocketLike;
  decodeFrame: (jpeg: Blob) => Promise<LongLiveFrame>;
  now: () => number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  composePrompt: (input: LongLiveComposeInput) => Promise<LongLiveComposed>;
  // Both absent: wardrobe changes are never confirmed, so the stream is never re-anchored.
  captureFrame?: (canvas: HTMLCanvasElement) => Promise<Blob | null>;
  observeWardrobe?: (
    input: LongLiveObserveInput,
  ) => Promise<LongLiveObservation>;
  onTranscriptEntry: (entry: TranscriptEntry) => void;
  onRequestStatus: (requestId: string, status: RequestStatus) => void;
  onLiveState: (state: LiveState) => void;
  onStreamState: (state: LongLiveStreamState) => void;
  onFirstFrame: () => void;
  onMetrics: (metrics: LongLiveMetrics) => void;
  onError: (message: string) => void;
  onEnded: (reason: LongLiveEndReason) => void;
  onDiagnostic?: (line: string) => void;
};

export type LongLiveOpenInput = {
  creator: CreatorProfile;
  state: LiveState;
  referenceImageUrl: string;
  speechMode: SpeechMode;
  startedAtMs: number;
  intentParser?: IntentParser;
  // The server's second-GPU face pass; absent means on.
  faceRestore?: boolean;
  // An id from the server's persona manifest; the server resolves the face, the client never sends one.
  personaId?: string;
};

type WardrobeCheck = {
  garments: GarmentId[];
  state: LiveState;
  settlePrompt: string;
};

const FAILURE_LINES = [
  "ugh, that one glitched on me, ask me again?",
  "hmm, my stream hiccuped, say that again?",
];

// Maps an http(s) service URL to its ws(s) twin, so either form works in LONGLIVE_URL.
export const buildLongLiveSocketUrl = (base: string, ticket: string): string =>
  `${base.replace(/^http/, "ws").replace(/\/+$/, "")}/ws?ticket=${encodeURIComponent(ticket)}`;

export class LongLiveSession {
  private readonly deps: LongLiveSessionDeps;
  private readonly pacer = new FramePacer<LongLiveFrame>(LONGLIVE_STREAM.fps);
  private ws: WebSocketLike | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private rafHandle: number | null = null;
  private decodeChain: Promise<void> = Promise.resolve();
  private sendQueue: Promise<void> = Promise.resolve();
  private creator: CreatorProfile | null = null;
  private state: LiveState | null = null;
  private referenceImageUrl = "";
  private speechMode: SpeechMode = "text";
  private intentParser: IntentParser | undefined;
  private faceRestore = true;
  private personaId: string | undefined;
  private startedAtMs = 0;
  // The greeting's clothing is the reference's; a change is unseen until vision confirms it on the stream.
  private wardrobeObserved = true;
  // Bumped on every composed state, so a slow vision read never overwrites a newer request's state.
  private stateVersion = 0;
  private checkInTimer: ReturnType<typeof setTimeout> | null = null;
  private wardrobeTimer: ReturnType<typeof setTimeout> | null = null;
  private checkedInSinceRequest = false;
  private liveSinceMs: number | null = null;
  // What the stream is showing now; a reconnect starts from it so the scene carries on.
  private currentPrompt = "";
  private transcript: TranscriptEntry[] = [];
  private idCounter = 0;
  private settleCounter = 0;
  // Requests sent but not yet superseded, oldest first, with the scene each one settles into.
  private pending: {
    requestId: string;
    settlePrompt: string;
    check: WardrobeCheck | null;
  }[] = [];
  private playingRequestId: string | null = null;
  private playingSinceMs: number | null = null;
  // The request whose prompt the latest start message carried, confirmed by that socket's ready.
  private startedWithRequestId: string | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settleIds = new Map<string, string>();
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private maxSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnects = 0;
  private everReady = false;
  private serverErrored = false;
  private closed = false;
  private failureCount = 0;
  private framesPainted = 0;
  private firstFrameMs: number | null = null;
  private stats: Pick<
    LongLiveMetrics,
    "genFps" | "blockMs" | "decodeMs" | "serverQueueFrames" | "loadMs"
  > = {
    genFps: null,
    blockMs: null,
    decodeMs: null,
    serverQueueFrames: null,
    loadMs: null,
  };
  private resolveOpen: (() => void) | null = null;
  private rejectOpen: ((error: Error) => void) | null = null;

  constructor(deps: LongLiveSessionDeps) {
    this.deps = deps;
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `longlive-${prefix}-${this.idCounter}`;
  }

  private elapsedSec(): number {
    return Math.max(0, Math.floor((this.deps.now() - this.startedAtMs) / 1000));
  }

  // The canvas mounts after open() resolves; the last frame is repainted onto it so it never starts black.
  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    const last = this.pacer.lastFrame;
    if (canvas && last) this.paint(last);
  }

  private paint(frame: LongLiveFrame): void {
    const canvas = this.canvas;
    if (!canvas) return;
    // Resizing clears a canvas, so it only happens when the frame size actually changes.
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    canvas.getContext("2d")?.drawImage(frame, 0, 0, frame.width, frame.height);
  }

  private startPaintLoop(): void {
    if (this.rafHandle !== null) return;
    const loop = () => {
      this.rafHandle = null;
      if (this.closed) return;
      const frame = this.pacer.tick(this.deps.now());
      if (frame) {
        this.paint(frame);
        this.framesPainted += 1;
        if (this.framesPainted === 1) {
          this.firstFrameMs = this.deps.now() - this.startedAtMs;
          this.deps.onFirstFrame();
        }
      }
      this.rafHandle = this.deps.requestFrame(loop);
    };
    this.rafHandle = this.deps.requestFrame(loop);
  }

  async open(input: LongLiveOpenInput): Promise<void> {
    this.creator = input.creator;
    this.state = input.state;
    this.referenceImageUrl = input.referenceImageUrl;
    this.speechMode = input.speechMode;
    this.startedAtMs = input.startedAtMs;
    this.intentParser = input.intentParser;
    this.faceRestore = input.faceRestore ?? true;
    this.personaId = input.personaId;

    const opening = await this.deps.composePrompt({
      creator: input.creator,
      state: input.state,
      transcript: [],
      channel: "chat",
      speechMode: input.speechMode,
      wardrobeObserved: true,
    });
    if (this.closed) return;
    this.currentPrompt = opening.prompt;

    await new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
      this.startPaintLoop();
      void this.connect();
    });
  }

  private settleOpen(error?: Error): void {
    const resolve = this.resolveOpen;
    const reject = this.rejectOpen;
    this.resolveOpen = null;
    this.rejectOpen = null;
    if (error) reject?.(error);
    else resolve?.();
  }

  private armOpenTimer(): void {
    this.clearOpenTimer();
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      this.fail("LongLive stream took too long to start.");
    }, OPEN_TIMEOUT_MS);
  }

  private clearOpenTimer(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  private fail(message: string): void {
    this.deps.onError(message);
    this.deps.onStreamState("failed");
    this.settleOpen(new Error(message));
    this.endSession("error");
  }

  private async connect(): Promise<void> {
    this.armOpenTimer();
    let ticket: LongLiveTicket;
    try {
      ticket = await this.deps.fetchTicket();
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error.message
          : "Could not get a LongLive ticket.",
      );
      return;
    }
    if (this.closed) return;
    const ws = this.deps.createWebSocket(
      buildLongLiveSocketUrl(ticket.url, ticket.ticket),
    );
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.startedWithRequestId = this.pending.at(-1)?.requestId;
      ws.send(
        JSON.stringify({
          type: "start",
          referenceImageUrl: this.referenceImageUrl,
          prompt: this.currentPrompt,
          width: LONGLIVE_STREAM.width,
          height: LONGLIVE_STREAM.height,
          fps: LONGLIVE_STREAM.fps,
          faceRestore: this.faceRestore,
          ...(this.personaId ? { personaId: this.personaId } : {}),
        }),
      );
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data === "string") {
        this.handleText(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.handleFrame(event.data);
      }
    };
    // The close event that always follows carries the code that decides a retry.
    ws.onerror = () => undefined;
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handleClose(event.code);
    };
  }

  private handleClose(code: number): void {
    if (this.closed) return;
    this.deps.onDiagnostic?.(`socket closed code=${code}`);
    if (code === CLOSE_UNAUTHORIZED || code === CLOSE_BAD_REQUEST) {
      this.fail(
        code === CLOSE_UNAUTHORIZED
          ? "LongLive rejected the session ticket."
          : "LongLive rejected the stream settings.",
      );
      return;
    }
    if (this.serverErrored || !this.everReady) {
      this.fail("LongLive stream failed to start.");
      return;
    }
    if (this.reconnects >= MAX_RECONNECTS) {
      this.deps.onStreamState("closed");
      this.endSession("streamClosed");
      return;
    }
    this.reconnects += 1;
    // The canvas stays on the last painted frame while the new socket warms up.
    this.deps.onStreamState("reconnecting");
    void this.connect();
  }

  private handleText(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success) return;
    this.handleMessage(parsed.data);
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "ready": {
        this.clearOpenTimer();
        if (message.fps) this.pacer.setFps(message.fps);
        this.stats = { ...this.stats, loadMs: message.loadMs ?? null };
        this.everReady = true;
        if (this.liveSinceMs === null) this.liveSinceMs = this.deps.now();
        this.startMaxSessionTimer();
        if (!this.checkInTimer && !this.checkedInSinceRequest)
          this.armCheckIn();
        this.deps.onStreamState("live");
        // A start that carried a request's prompt (an ask sent while connecting, or a reconnect) puts that request on screen.
        this.promptTookEffect(this.startedWithRequestId);
        this.settleOpen();
        this.emitMetrics();
        return;
      }
      case "promptApplied": {
        const settleRequestId = this.settleIds.get(message.id);
        if (settleRequestId !== undefined) {
          this.settleIds.delete(message.id);
          if (this.playingRequestId === settleRequestId) {
            this.deps.onRequestStatus(settleRequestId, "done");
            this.playingRequestId = null;
          }
          return;
        }
        this.promptTookEffect(message.id);
        return;
      }
      case "stats": {
        this.stats = {
          ...this.stats,
          genFps: message.genFps ?? this.stats.genFps,
          blockMs: message.blockMs ?? this.stats.blockMs,
          decodeMs: message.decodeMs ?? this.stats.decodeMs,
          serverQueueFrames:
            message.queueFrames ?? this.stats.serverQueueFrames,
        };
        this.emitMetrics();
        return;
      }
      case "reanchored": {
        this.deps.onDiagnostic?.(
          `re-anchored ${message.id} at frame ${message.atFrame ?? "?"}`,
        );
        return;
      }
      case "error": {
        this.serverErrored = true;
        this.deps.onError(message.message ?? "LongLive stream error");
        return;
      }
    }
  }

  // A request's prompt is live on screen: it plays, anything older is superseded, and the scene settles after a while.
  private promptTookEffect(requestId: string | undefined): void {
    if (!requestId) return;
    const index = this.pending.findIndex(
      (entry) => entry.requestId === requestId,
    );
    if (index === -1) return;
    const entry = this.pending[index];
    if (!entry) return;
    for (const older of this.pending.slice(0, index)) {
      this.deps.onRequestStatus(older.requestId, "done");
    }
    if (this.playingRequestId && this.playingRequestId !== requestId) {
      this.deps.onRequestStatus(this.playingRequestId, "done");
    }
    this.pending = this.pending.slice(index + 1);
    this.playingRequestId = requestId;
    this.playingSinceMs = this.deps.now();
    this.deps.onRequestStatus(requestId, "playing");
    this.scheduleSettle(requestId, entry.settlePrompt, entry.check);
  }

  private scheduleSettle(
    requestId: string,
    settlePrompt: string,
    check: WardrobeCheck | null,
  ): void {
    this.clearSettleTimer();
    this.clearWardrobeTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.closed || this.playingRequestId !== requestId) return;
      this.clearWardrobeTimer();
      this.sendSettle(requestId, settlePrompt);
    }, LONGLIVE_SETTLE_AFTER_MS);
    if (check) this.scheduleWardrobeCheck(requestId, check, 1);
  }

  private sendSettle(requestId: string, settlePrompt: string): void {
    this.settleCounter += 1;
    const id = `settle-${this.settleCounter}`;
    this.settleIds.set(id, requestId);
    this.sendPrompt(settlePrompt, id);
  }

  // The removal plays about 4 to 6 s in and the looping action redresses her soon after, so the 12 s settle is too late to see it.
  private scheduleWardrobeCheck(
    requestId: string,
    check: WardrobeCheck,
    attempt: number,
  ): void {
    const delay =
      attempt === 1
        ? LONGLIVE_WARDROBE_CHECK_AFTER_MS
        : LONGLIVE_WARDROBE_CHECK_EVERY_MS;
    this.wardrobeTimer = setTimeout(() => {
      this.wardrobeTimer = null;
      void this.checkWardrobe(requestId, check, attempt);
    }, delay);
  }

  // A confirmed change ends the action at once: re-anchor, then settle naming what she now wears.
  private async checkWardrobe(
    requestId: string,
    check: WardrobeCheck,
    attempt: number,
  ): Promise<void> {
    if (this.closed || this.playingRequestId !== requestId) return;
    const version = this.stateVersion;
    const observation = await this.observe(check);
    // A newer ask, or the plain settle already sent, owns the stream now.
    if (
      this.closed ||
      this.playingRequestId !== requestId ||
      this.settleTimer === null ||
      version !== this.stateVersion
    )
      return;
    const last = attempt >= LONGLIVE_WARDROBE_CHECK_ATTEMPTS;
    this.deps.onDiagnostic?.(
      `wardrobe ${check.garments.join(",")} check ${attempt}: ${observation ? (observation.confirmed ? "confirmed" : "not confirmed") : "skipped"}`,
    );
    if (observation?.confirmed) {
      this.clearSettleTimer();
      this.applyObservedState(observation.state);
      this.wardrobeObserved = true;
      this.sendReanchor();
      this.sendSettle(
        requestId,
        observation.settlePrompt ?? check.settlePrompt,
      );
      return;
    }
    if (!last) {
      this.scheduleWardrobeCheck(requestId, check, attempt + 1);
      return;
    }
    // Mid-removal misses are expected; only the last read reconciles what she is wearing.
    if (observation) this.applyObservedState(observation.state);
    // A clear read is ground truth, so prompts name her clothing again instead of leaving it to the model.
    if (observation?.seen) this.wardrobeObserved = true;
  }

  private applyObservedState(state: LiveState): void {
    this.state = state;
    this.deps.onLiveState(state);
  }

  private clearWardrobeTimer(): void {
    if (this.wardrobeTimer) {
      clearTimeout(this.wardrobeTimer);
      this.wardrobeTimer = null;
    }
  }

  private async observe(
    check: WardrobeCheck,
  ): Promise<LongLiveObservation | null> {
    const { captureFrame, observeWardrobe } = this.deps;
    const canvas = this.canvas;
    const creator = this.creator;
    if (!captureFrame || !observeWardrobe || !canvas || !creator) return null;
    try {
      const frame = await captureFrame(canvas);
      if (!frame) return null;
      return await observeWardrobe({
        creator,
        state: check.state,
        garments: check.garments,
        frame,
        referenceImageUrl: this.referenceImageUrl,
      });
    } catch {
      return null;
    }
  }

  // Pins the newest block beside the reference, so the confirmed clothing is held instead of drifting back.
  private sendReanchor(): void {
    const ws = this.ws;
    if (ws && ws.readyState === WS_OPEN) {
      ws.send(
        JSON.stringify({ type: "reanchor", id: this.nextId("reanchor") }),
      );
    }
  }

  private clearSettleTimer(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private sendPrompt(prompt: string, id: string): void {
    this.currentPrompt = prompt;
    const ws = this.ws;
    // While reconnecting, the next start message carries currentPrompt instead.
    if (ws && ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify({ type: "prompt", prompt, id }));
    }
  }

  private handleFrame(data: ArrayBuffer): void {
    if (data.byteLength <= FRAME_HEADER_BYTES) return;
    const jpeg = new Blob([data.slice(FRAME_HEADER_BYTES)], {
      type: "image/jpeg",
    });
    // Decoded one at a time so frames reach the buffer in the order they were sent.
    this.decodeChain = this.decodeChain.then(async () => {
      try {
        const frame = await this.deps.decodeFrame(jpeg);
        if (this.closed) {
          frame.close();
          return;
        }
        this.pacer.push(frame);
      } catch {
        // A corrupt frame is skipped; the canvas keeps the previous one.
      }
    });
  }

  request(text: string, channel: InputChannel, paid?: boolean): void {
    const trimmed = text.trim();
    if (!trimmed || this.closed || !this.creator) return;
    const entry: TranscriptEntry = {
      id: this.nextId("fan"),
      role: "fan",
      channel,
      text: trimmed,
      atSec: this.elapsedSec(),
      ...(paid !== undefined ? { paid } : {}),
    };
    // Like the director, each fan ask restarts the quiet stretch a check-in waits for.
    this.checkedInSinceRequest = false;
    this.armCheckIn();
    this.transcript = [...this.transcript, entry];
    this.deps.onTranscriptEntry(entry);
    this.deps.onRequestStatus(entry.id, "queued");
    // Chained so concurrent asks compose against the state the previous one left behind.
    this.sendQueue = this.sendQueue.then(() =>
      this.sendRequest(entry, trimmed, channel),
    );
  }

  private async sendRequest(
    entry: TranscriptEntry,
    text: string,
    channel: InputChannel,
  ): Promise<void> {
    const creator = this.creator;
    const state = this.state;
    if (!creator || !state || this.closed) return;
    let composed: LongLiveComposed;
    try {
      composed = await this.deps.composePrompt({
        creator,
        state,
        transcript: this.transcript.slice(-LIVE_TUNABLES.TRANSCRIPT_WINDOW),
        requestText: text,
        channel,
        speechMode: this.speechMode,
        intentParser: this.intentParser,
        wardrobeObserved: this.wardrobeObserved,
      });
    } catch {
      this.deps.onRequestStatus(entry.id, "failed");
      this.pushFailureLine();
      return;
    }
    if (this.closed) return;
    await this.holdPlayingAction();
    if (this.closed) return;
    this.applyComposedState(composed.state);
    this.pushReply(composed.reply, channel);
    const garments = composed.wardrobeCheck ?? [];
    // An asked change is unseen until confirmed; until then prompts stop naming clothing at all.
    if (garments.length > 0) this.wardrobeObserved = false;
    // A new ask replaces any pending settle; its own settle is scheduled once it takes effect.
    this.clearSettleTimer();
    this.clearWardrobeTimer();
    this.pending = [
      ...this.pending,
      {
        requestId: entry.id,
        settlePrompt: composed.settlePrompt,
        check:
          garments.length > 0
            ? {
                garments,
                state: composed.state,
                settlePrompt: composed.settlePrompt,
              }
            : null,
      },
    ];
    this.deps.onRequestStatus(entry.id, "generating");
    this.sendPrompt(composed.prompt, entry.id);
  }

  private async holdPlayingAction(): Promise<void> {
    if (!this.playingRequestId || this.playingSinceMs === null) return;
    const remaining =
      LONGLIVE_MIN_ACTION_MS - (this.deps.now() - this.playingSinceMs);
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  private applyComposedState(state: LiveState): void {
    this.state = state;
    this.stateVersion += 1;
    this.deps.onLiveState(state);
  }

  private pushReply(reply: string | null, channel: InputChannel): void {
    if (!reply) return;
    const replyEntry: TranscriptEntry = {
      id: this.nextId("creator"),
      role: "creator",
      channel,
      text: reply,
      atSec: this.elapsedSec(),
    };
    this.transcript = [...this.transcript, replyEntry];
    this.deps.onTranscriptEntry(replyEntry);
  }

  private armCheckIn(): void {
    this.clearCheckInTimer();
    if (this.closed) return;
    this.checkInTimer = setTimeout(() => {
      this.checkInTimer = null;
      this.sendQueue = this.sendQueue.then(() => this.checkIn());
    }, LIVE_TUNABLES.CHECK_IN_AFTER_IDLE_MS);
  }

  private clearCheckInTimer(): void {
    if (this.checkInTimer) {
      clearTimeout(this.checkInTimer);
      this.checkInTimer = null;
    }
  }

  // Clip mode's check-in: one per quiet stretch, never over an ask still playing.
  private async checkIn(): Promise<void> {
    const creator = this.creator;
    const state = this.state;
    if (!creator || !state || this.closed || this.checkedInSinceRequest) return;
    if (this.pending.length > 0 || this.playingRequestId) {
      this.armCheckIn();
      return;
    }
    this.checkedInSinceRequest = true;
    const channel = this.transcript.at(-1)?.channel ?? "chat";
    let composed: LongLiveComposed;
    try {
      composed = await this.deps.composePrompt({
        creator,
        state,
        transcript: this.transcript.slice(-LIVE_TUNABLES.TRANSCRIPT_WINDOW),
        channel,
        speechMode: this.speechMode,
        wardrobeObserved: this.wardrobeObserved,
        checkIn: true,
      });
    } catch {
      return;
    }
    // An ask that arrived while composing owns the stream now.
    if (this.closed || this.pending.length > 0 || this.playingRequestId) return;
    this.pushReply(composed.reply, channel);
    this.clearSettleTimer();
    this.sendPrompt(composed.prompt, this.nextId("checkin"));
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.closed) return;
      this.settleCounter += 1;
      this.sendPrompt(composed.settlePrompt, `settle-${this.settleCounter}`);
    }, LONGLIVE_SETTLE_AFTER_MS);
  }

  private pushFailureLine(): void {
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

  private emitMetrics(): void {
    this.deps.onMetrics(this.getMetricsWithCost());
  }

  getMetricsWithCost(): LongLiveMetrics {
    const liveSec =
      this.liveSinceMs !== null
        ? Math.max(0, (this.deps.now() - this.liveSinceMs) / 1000)
        : 0;
    return {
      ...this.stats,
      bufferedFrames: this.pacer.bufferedFrames,
      playbackRate: this.pacer.playbackRate,
      underruns: this.pacer.underruns,
      droppedFrames: this.pacer.dropped,
      framesPainted: this.framesPainted,
      reconnects: this.reconnects,
      firstFrameMs: this.firstFrameMs,
      costUsd:
        liveSec *
        (LIVE_TUNABLES.LONGLIVE_COST_PER_SEC_USD +
          (this.faceRestore || this.personaId
            ? LIVE_TUNABLES.LONGLIVE_FACE_RESTORE_COST_PER_SEC_USD
            : 0)),
    };
  }

  private endSession(reason: LongLiveEndReason): void {
    if (this.closed) return;
    this.closed = true;
    this.clearOpenTimer();
    this.clearSettleTimer();
    this.clearCheckInTimer();
    this.clearWardrobeTimer();
    if (this.maxSessionTimer) {
      clearTimeout(this.maxSessionTimer);
      this.maxSessionTimer = null;
    }
    if (this.rafHandle !== null) {
      this.deps.cancelFrame(this.rafHandle);
      this.rafHandle = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: "stop" }));
      ws.close(CLOSE_NORMAL);
    }
    // The canvas keeps its last pixels; only the bitmaps are released.
    this.pacer.dispose();
    this.settleOpen(new Error(`LongLive session ended (${reason})`));
    this.deps.onEnded(reason);
  }

  close(): void {
    this.endSession("stopped");
  }
}
