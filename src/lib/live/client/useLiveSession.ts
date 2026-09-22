"use client";

// Wires LiveDirector + ClipPipeline + GaplessPlayer into a React hook, and times the creator's
// typed-reply reveal to land in chat when her typing beat would actually finish on screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";
import { LiveDirector, type RequestStatus } from "@/lib/live/client/director";
import {
  DirectorSession,
  openRealtimeWithFal,
  type DirectorMetrics,
  type DirectorRealtimeState,
} from "@/lib/live/client/directorStream";
import {
  buildLucyPrompt,
  fetchAsDataUri,
  LUCY_INPUT,
  LUCY_MAX_REOPENS,
  LucySession,
  openRealtimeWithFalLucy,
  shouldReopenLucy,
  type LucyMetrics,
  type LucyRealtimeState,
} from "@/lib/live/client/lucyStream";
import { ClipPipeline, type PipelineEvent } from "@/lib/live/client/pipeline";
import {
  GaplessPlayer,
  type ClipToPlay,
  type PlayerStatus,
} from "@/lib/live/client/gaplessPlayer";
import {
  RenderStatsTracker,
  type RenderPercentiles,
} from "@/lib/live/client/renderStats";
import {
  createSeededRandom,
  RoomSim,
  type RoomChatMessage,
} from "@/lib/live/client/roomSim";
import {
  LIVE_TUNABLES,
  type ClipJob,
  type ClipJobKind,
  type ClipRequest,
  type ClipResult,
  type ClipSwapReport,
  type CreatorProfile,
  type InputChannel,
  type LiveState,
  type RenderBackend,
  type SceneId,
  type SpeechMode,
  type TranscriptEntry,
  type Wardrobe,
} from "@/lib/live/contract";

export type ReferenceUploadResult = {
  anchorFrameUrl: string;
  // The greeting's first frame: a staged in-scene still when staging succeeded, otherwise the upload itself.
  seedFrameUrl: string;
  staged: boolean;
  stageCostUsd: number;
  wardrobe: Wardrobe;
  lookLock: string;
  // Actual room visible in the photo, captured by vision; undefined falls back to the sceneId preset.
  surroundings?: string;
  // Actual crop of the photo, captured by vision; undefined falls back to a "medium" guess.
  framing?: "wider" | "medium" | "torso";
  captured: boolean;
};

export type LiveSessionStatus =
  "connecting" | "live" | "holding" | "ended" | "error";

export type BufferDepth = {
  idleReady: number;
  idleInflight: number;
  chainedReady: number;
  bufferedSec: number;
};

export type StartOptions = {
  displayName: string;
  backend?: RenderBackend;
  speechMode?: SpeechMode;
};

export type UseLiveSessionDeps = {
  renderClip: (req: ClipRequest) => Promise<ClipResult>;
  uploadReference: (
    file: File,
    sceneId: SceneId,
    stage?: boolean,
  ) => Promise<ReferenceUploadResult>;
  upscaleSeed?: (
    frameUrl: string,
  ) => Promise<{ url: string | null; costUsd: number }>;
  composeDirectorPrompt: (input: {
    creator: CreatorProfile;
    transcript: TranscriptEntry[];
    world: string;
    requestText: string;
    channel: InputChannel;
    speechMode: SpeechMode;
  }) => Promise<{ prompt: string; reply: string }>;
  // Lucy mode only (backend === "lucy"); unused otherwise.
  fetchLucyToken: () => Promise<string>;
  // Swap mode only; starts the GPU container before the first clip needs it.
  warmSwap: () => Promise<void>;
  // Swap mode only: second phase of a clip that came back with swap.status "pending".
  swapRenderedClip?: (
    result: ClipResult,
    referenceImageUrl: string,
  ) => Promise<{ videoUrl: string; costUsd: number; report: ClipSwapReport }>;
  // Optional: playback and connect events for the server log; tests leave it out.
  reportTelemetry?: (
    event: string,
    detail: Record<string, string | number | boolean | null>,
  ) => void;
};

// Staging state of the reference step started from the setup screen: "unstaged" is a completed step whose still was refused or failed, so the greeting starts on the photo.
export type PrepareStatus =
  "idle" | "staging" | "ready" | "uploaded" | "unstaged" | "failed";

// A join that has not shown the greeting by now is the "stuck in connecting" report; log where it stalled.
const CONNECT_STALL_MS = 60_000;

const EMPTY_BUFFER_DEPTH: BufferDepth = {
  idleReady: 0,
  idleInflight: 0,
  chainedReady: 0,
  bufferedSec: 0,
};

export type StudioTimings = {
  jobKind: ClipResult["jobKind"];
  renderMs: number;
  costUsd: number;
  swap: ClipSwapReport | null;
};

// Real join-flow progress, driven by actual pipeline milestones (see useLiveSession.start).
export type ConnectStage =
  "uploading" | "capturingLook" | "renderingFirstClip" | "primingBuffer";

export type QueueOwner =
  { type: "fan" } | { type: "viewer"; handle: string } | { type: "studio" };

// `requestId` is only set for a reply/beat job (a request-owned act); it's what the failed-chip
// timeout and the "playing" transition key off.
export type QueueStripEntry = {
  kind: ClipJobKind;
  owner: QueueOwner;
  requestId?: string;
};

export type TypingDevice = "laptop" | "phone" | null;

export type SessionEndReason =
  | "maxDuration"
  | "costCap"
  // Director-only: the fal stream ended itself (stream_exhausted / a fatal error message).
  | "streamEnded"
  | null;

const EMPTY_QUEUE_STRIP: {
  current: QueueStripEntry | null;
  queued: QueueStripEntry[];
} = { current: null, queued: [] };

const ownerForReplyJob = (job: {
  from: "fan" | "viewer";
  handle?: string;
}): QueueOwner =>
  job.from === "viewer"
    ? { type: "viewer", handle: job.handle ?? "viewer" }
    : { type: "fan" };

// A chain job's own request id, if it has one (director-originated beats like `rest` don't).
const requestIdForJob = (job: ClipJob): string | null => {
  if (job.kind === "reply") {
    return job.requestId;
  }
  if (job.kind === "beat") {
    return job.beat.requestId ?? null;
  }
  return null;
};

// Fixed in-character lines for a request that failed all its render attempts; client-side only,
// rotated by failure count so the same line doesn't repeat back to back.
const FAILURE_LINES = [
  "ugh, that one glitched on me, ask me again?",
  "hmm, my camera's acting up, say that again?",
  "oops, lost that one, mind trying again?",
];

// How long the queue strip keeps showing a failed request's chip before clearing it.
const FAILED_CHIP_VISIBLE_MS = 6_000;

export function useLiveSession(deps: UseLiveSessionDeps) {
  const [status, setStatus] = useState<LiveSessionStatus>("connecting");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [costTotal, setCostTotal] = useState(0);
  const [bufferDepth, setBufferDepth] =
    useState<BufferDepth>(EMPTY_BUFFER_DEPTH);
  const [typingCreator, setTypingCreator] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  // Requests are accepted as soon as the director and pipeline exist, well before the greeting is on screen; a request sent during the intro queues behind it.
  const [acceptingRequests, setAcceptingRequests] = useState(false);
  const preparedReferenceRef = useRef<{
    file: File;
    sceneId: SceneId;
    stage: boolean;
    promise: Promise<ReferenceUploadResult>;
  } | null>(null);
  const [prepareStatus, setPrepareStatus] = useState<PrepareStatus>("idle");
  const [preparedSeedUrl, setPreparedSeedUrl] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackendState] = useState<RenderBackend>("turbo");
  const [speechMode, setSpeechModeState] = useState<SpeechMode>("text");
  const [anchorChangedAtMs, setAnchorChangedAtMs] = useState<number | null>(
    null,
  );
  const [lastTimings, setLastTimings] = useState<StudioTimings | null>(null);
  const [renderStats, setRenderStats] = useState<RenderPercentiles | null>(
    null,
  );
  const [connectStage, setConnectStageState] =
    useState<ConnectStage>("uploading");
  const connectStageRef = useRef<ConnectStage>("uploading");
  const connectStartedAtMsRef = useRef(0);
  const connectStallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reportTelemetry = deps.reportTelemetry;
  const setConnectStage = useCallback(
    (stage: ConnectStage) => {
      connectStageRef.current = stage;
      setConnectStageState(stage);
      reportTelemetry?.("connectStage", {
        stage,
        ms: Date.now() - connectStartedAtMsRef.current,
      });
    },
    [reportTelemetry],
  );
  const [roomEvents, setRoomEvents] = useState<RoomChatMessage[]>([]);
  const [viewerCount, setViewerCount] = useState(0);
  const [typingDevice, setTypingDevice] = useState<TypingDevice>(null);
  const [queueStrip, setQueueStrip] = useState(EMPTY_QUEUE_STRIP);
  // Per-request lifecycle (queued/generating/playing/done/failed), mirrored from the director.
  const [requestStatuses, setRequestStatusesState] = useState<
    Record<string, RequestStatus>
  >({});
  const [endReason, setEndReason] = useState<SessionEndReason>(null);
  // The director's own clock; transcript.atSec is relative to this, set once the director exists.
  const [sessionStartedAtMs, setSessionStartedAtMs] = useState<number | null>(
    null,
  );
  const [offline, setOffline] = useState(
    () => typeof navigator !== "undefined" && !navigator.onLine,
  );
  // Client-only presentation state: private mode pauses the room sim (no ambient chatter, no
  // viewer requests) without touching the director/pipeline/render engine underneath it.
  const [privateMode, setPrivateModeState] = useState(false);
  const privateModeRef = useRef(false);
  // Director-only readout for StudioOverlay; null in turbo/reference mode.
  const [directorMetrics, setDirectorMetrics] =
    useState<DirectorMetrics | null>(null);
  const [directorStreamState, setDirectorStreamState] =
    useState<DirectorRealtimeState | null>(null);
  // Lucy-only readout for StudioOverlay; null outside lucy mode.
  const [lucyMetrics, setLucyMetrics] = useState<LucyMetrics | null>(null);
  const [lucyStreamState, setLucyStreamState] =
    useState<LucyRealtimeState | null>(null);

  const directorRef = useRef<LiveDirector | null>(null);
  const pipelineRef = useRef<ClipPipeline | null>(null);
  const roomRef = useRef<RoomSim | null>(null);
  // Which engine `send`/`end`/mute-toggle route to for the active session.
  const modeRef = useRef<"clip" | "director" | "lucy">("clip");
  const directorSessionRef = useRef<DirectorSession | null>(null);
  const directorMediaStreamRef = useRef<MediaStream | null>(null);
  // Desired sound state for the director video element; mirrors `soundOn` in LiveStudio.
  const directorSoundOnRef = useRef(true);
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const lucySessionRef = useRef<LucySession | null>(null);
  const lucyMediaStreamRef = useRef<MediaStream | null>(null);
  // Video-only in lucy mode (no audio track on the canvas capture), so nothing to mute per se —
  // kept for parity with directorSoundOnRef and a possible future audio pass-through.
  const lucySoundOnRef = useRef(true);
  // The turbo pipeline's hidden output driving Lucy's restyle; created programmatically (not via JSX) because it must exist and be playing before lucySession.open() runs, which is before "live" mounts LiveStudio's video elements.
  const lucyHiddenARef = useRef<HTMLVideoElement | null>(null);
  const lucyHiddenBRef = useRef<HTMLVideoElement | null>(null);
  const lucyCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lucyRafRef = useRef<number | null>(null);
  const lucyStreamCostBaseRef = useRef(0);
  const speechModeRef = useRef<SpeechMode>("text");
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const greetingPlayedRef = useRef(false);
  // Clip ids whose canon already advanced on clipRendered (two-phase swap), so clipReady does not advance it twice.
  const canonAdvancedRef = useRef(new Set<string>());
  const liveStateRef = useRef<LiveState | null>(null);
  const currentOwnerRef = useRef<QueueOwner>({ type: "studio" });
  const currentActRef = useRef<QueueStripEntry | null>(null);
  const pendingTipCentsRef = useRef<number | undefined>(undefined);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The request id owned by the chain job currently rendering (or last dispatched), if any.
  const currentRequestIdRef = useRef<string | null>(null);
  // Maps a delivered clip's id back to the request it belongs to, for the "playing" transition.
  const requestIdByClipIdRef = useRef<Map<string, string>>(new Map());
  // Rotates through FAILURE_LINES without repeating the same one twice in a row.
  const failureCountRef = useRef(0);
  const failedChipTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(
    new Set(),
  );
  // Indirection so the tick interval (created in `start`) always calls the current `end`, defined later.
  const endRef = useRef<() => void>(() => {});
  // Maps a rendered clip's id to what it was, so the player's onClipStarted (id only) can look
  // up job kind / reply for chat-sync and the connecting -> live transition.
  const clipMetaRef = useRef<Map<string, ClipResult>>(new Map());
  const renderStatsTrackerRef = useRef(new RenderStatsTracker());
  // requestId -> when its fan message was sent, for request-to-first-visible-frame logging.
  const requestSentAtMsRef = useRef<Map<string, number>>(new Map());
  // The clip actually on screen right now (set from onClipStarted), used to gate background
  // timers on whether that clip is a real request/beat vs. idle filler.
  const currentPlayingClipIdRef = useRef<string | null>(null);
  const pendingRevealRef = useRef<{
    clipId: string;
    text: string;
    channel: InputChannel;
    typingLeadSec: number;
  } | null>(null);

  const clearPendingReveal = useCallback(() => {
    pendingRevealRef.current = null;
    setTypingCreator(false);
    setTypingDevice(null);
  }, []);

  const revealIfDue = useCallback((currentTimeSec: number, clipId: string) => {
    const pending = pendingRevealRef.current;
    const director = directorRef.current;
    if (!pending || !director || pending.clipId !== clipId) {
      return;
    }
    if (currentTimeSec < pending.typingLeadSec) {
      return;
    }
    pendingRevealRef.current = null;
    setTypingCreator(false);
    setTypingDevice(null);
    const now = Date.now();
    setTranscript((prev) => [
      ...prev,
      {
        id: `${pending.clipId}-reply`,
        role: "creator",
        channel: pending.channel,
        text: pending.text,
        atSec: Math.max(
          0,
          Math.floor((now - director.getState().startedAt) / 1000),
        ),
      },
    ]);
  }, []);

  const getNextClip = useCallback((): ClipToPlay | null => {
    const pipeline = pipelineRef.current;
    if (!pipeline) {
      return null;
    }
    const result = pipeline.nextClip();
    if (modeRef.current === "lucy") {
      console.info(
        `lucy pipeline: nextClip -> ${result ? `${result.jobKind} ${result.clipId}` : "none"}`,
      );
    }
    if (!result) {
      return null;
    }
    clipMetaRef.current.set(result.clipId, result);
    return {
      id: result.clipId,
      videoUrl: result.videoUrl,
      durationSec: result.durationSec,
      hasSpeech: speechModeRef.current === "native" && result.reply !== null,
      loops: result.loops,
      interrupts: result.jobKind !== "idle",
    };
  }, []);

  const hasInterruptReady = useCallback(
    (): boolean => pipelineRef.current?.hasChainedReady() ?? false,
    [],
  );

  const returnClip = useCallback((clipId: string) => {
    const result = clipMetaRef.current.get(clipId);
    if (result) {
      pipelineRef.current?.requeue(result);
    }
  }, []);

  // Built once via lazy useState init; onProgress/onClipStarted/getNextClip read refs, so they're wired post-render below instead of passed here.
  const [player] = useState(
    () =>
      new GaplessPlayer({
        onStatusChange: (playerStatus: PlayerStatus) => {
          if (playerStatus === "holding" || playerStatus === "needsTap") {
            deps.reportTelemetry?.("playerStatus", { status: playerStatus });
          }
          setNeedsTap(playerStatus === "needsTap");
          if (playerStatus === "holding") {
            setStatus((current) => (current === "live" ? "holding" : current));
          } else if (playerStatus === "playing") {
            setStatus((current) => (current === "holding" ? "live" : current));
          }
        },
      }),
  );

  const refreshBufferDepth = useCallback(() => {
    const pipeline = pipelineRef.current;
    if (!pipeline) {
      return;
    }
    const stats = pipeline.getBufferStats();
    setBufferDepth({
      idleReady: stats.idleReady,
      idleInflight: stats.idleInflight,
      chainedReady: stats.chainedReady,
      bufferedSec: pipeline.getReadyDurationsSec() + player.getBufferedSec(),
    });
  }, [player]);

  const applyLiveState = useCallback((next: LiveState) => {
    liveStateRef.current = next;
    setLiveState(next);
  }, []);

  // Snapshot of "what's playing now, what's next, whose request it is" for the queue strip UI.
  const refreshQueueStrip = useCallback(() => {
    const director = directorRef.current;
    if (!director) {
      return;
    }
    const queued = director.getState().jobQueue.map((job): QueueStripEntry => ({
      kind: job.kind,
      owner:
        job.kind === "reply" ? ownerForReplyJob(job) : currentOwnerRef.current,
    }));
    setQueueStrip({ current: currentActRef.current, queued });
  }, []);

  // Mirrors the director's per-request status map onto session state for the UI to read.
  const refreshRequestStatuses = useCallback(() => {
    const director = directorRef.current;
    if (!director) {
      return;
    }
    setRequestStatusesState(director.getState().requestStatuses);
  }, []);

  const isSystemIdle = useCallback((): boolean => {
    const director = directorRef.current;
    const pipeline = pipelineRef.current;
    if (!director || !pipeline) {
      return false;
    }
    return director.getState().jobQueue.length === 0 && pipeline.isChainIdle();
  }, []);

  // Whether background timers (rest/checkIn) must hold off: a chain job in flight or not yet
  // promoted/played, or the clip currently on screen being a real request/beat rather than idle.
  const isBusy = useCallback((): boolean => {
    if (pipelineRef.current?.isChainActive()) {
      return true;
    }
    const clipId = currentPlayingClipIdRef.current;
    const playing = clipId ? clipMetaRef.current.get(clipId) : null;
    return (
      playing !== null && playing !== undefined && playing.jobKind !== "idle"
    );
  }, []);

  // Ambient room life is the viewer count only: other fans never speak or make requests, so the
  // show is a one-to-one conversation and her state changes only on this fan's requests.
  const tickRoom = useCallback(() => {
    const room = roomRef.current;
    const director = directorRef.current;
    if (!room || !director || privateModeRef.current) {
      return;
    }
    const result = room.tick({
      nowMs: Date.now(),
      liveState: liveStateRef.current,
      systemIdle: isSystemIdle(),
      tipMenu: director.getState().creator.tipMenu,
    });
    setViewerCount(result.viewerCount);
  }, [isSystemIdle]);

  // Live once the first clip is on screen; the pipeline count reads zero once the player preloads.
  const maybeGoLive = useCallback(() => {
    if (!greetingPlayedRef.current) {
      return;
    }
    if (connectStallTimeoutRef.current) {
      clearTimeout(connectStallTimeoutRef.current);
      connectStallTimeoutRef.current = null;
      reportTelemetry?.("connected", {
        ms: Date.now() - connectStartedAtMsRef.current,
      });
    }
    setStatus((current) => (current === "connecting" ? "live" : current));
  }, [reportTelemetry]);

  const handleClipStarted = useCallback(
    (clipId: string) => {
      currentPlayingClipIdRef.current = clipId;
      const result = clipMetaRef.current.get(clipId);
      if (result) {
        pipelineRef.current?.onClipStarted(result.seedFrameUrl);
      }
      // Displayed state only advances once the viewer actually sees the clip, not at render time.
      if (
        result &&
        result.jobKind !== "idle" &&
        result.verdict === "approved"
      ) {
        applyLiveState(result.state);
      }
      // The request's clip is now actually on screen, not just rendered.
      const requestId = requestIdByClipIdRef.current.get(clipId);
      if (requestId) {
        directorRef.current?.setRequestStatus(requestId, "playing");
        refreshRequestStatuses();
        const sentAtMs = requestSentAtMsRef.current.get(requestId);
        if (sentAtMs !== undefined) {
          const requestMs = Date.now() - sentAtMs;
          console.log(
            `useLiveSession: request-to-first-visible-frame requestId=${requestId} ms=${requestMs}`,
          );
          // Server logs only see a request once the pipeline dispatches it; this is the time the fan actually waited.
          reportTelemetry?.("requestVisible", {
            clipId,
            kind: result?.jobKind ?? "unknown",
            ms: requestMs,
          });
          requestSentAtMsRef.current.delete(requestId);
        }
      }
      refreshBufferDepth();
      reportTelemetry?.("clipStarted", {
        clipId,
        kind: result?.jobKind ?? "unknown",
        durationSec: result?.durationSec ?? null,
      });
      // A request typed during the intro is already queued behind the greeting, or rendering as its reply; she is seen reading it now.
      if (
        result?.jobKind === "greeting" &&
        (currentActRef.current?.kind === "reply" ||
          directorRef.current
            ?.getState()
            .jobQueue.some((job) => job.kind === "reply"))
      ) {
        setTypingCreator(true);
      }
      greetingPlayedRef.current = true;
      maybeGoLive();
    },
    [
      applyLiveState,
      maybeGoLive,
      refreshBufferDepth,
      refreshRequestStatuses,
      reportTelemetry,
    ],
  );

  const getFallbackClip = useCallback((): ClipToPlay | null => {
    const pipeline = pipelineRef.current;
    if (!pipeline) {
      return null;
    }
    const result = pipeline.nextFallbackClip();
    if (!result) {
      return null;
    }
    console.warn(
      `useLiveSession: boundary fallback, cutting to idle ${result.clipId} instead of holding`,
    );
    reportTelemetry?.("boundaryFallback", { clipId: result.clipId });
    clipMetaRef.current.set(result.clipId, result);
    return {
      id: result.clipId,
      videoUrl: result.videoUrl,
      durationSec: result.durationSec,
      hasSpeech: false,
      loops: result.loops,
      interrupts: false,
    };
  }, [reportTelemetry]);

  useEffect(() => {
    player.setProgressHandler(revealIfDue);
    player.setClipStartedHandler(handleClipStarted);
    player.setNextClipHandler(getNextClip);
    player.setFallbackClipHandler(getFallbackClip);
    player.setInterruptReadyHandler(hasInterruptReady);
    player.setClipReturnedHandler(returnClip);
    player.setClipFailedHandler((clipId, reason) => {
      reportTelemetry?.("clipFailed", { clipId, reason });
    });
  }, [
    reportTelemetry,
    player,
    revealIfDue,
    handleClipStarted,
    getNextClip,
    getFallbackClip,
    hasInterruptReady,
    returnClip,
  ]);

  const handlePipelineEvent = useCallback(
    (event: PipelineEvent) => {
      const director = directorRef.current;
      if (!director) {
        return;
      }
      if (event.type === "bufferEmpty") {
        setStatus((current) => (current === "live" ? "holding" : current));
        refreshBufferDepth();
        return;
      }
      if (event.type === "bufferRecovered") {
        player.checkForClip();
        setStatus((current) => (current === "holding" ? "live" : current));
        refreshBufferDepth();
        return;
      }
      if (event.type === "anchorChanged") {
        setAnchorChangedAtMs(event.atMs);
        refreshBufferDepth();
        return;
      }
      if (event.type === "clipDiscarded") {
        setCostTotal((total) => total + event.costUsd);
        refreshBufferDepth();
        return;
      }
      if (event.type === "error") {
        setError(event.message);
        setTypingCreator(false);
        if (typingDelayRef.current) {
          clearTimeout(typingDelayRef.current);
          typingDelayRef.current = null;
        }
        refreshBufferDepth();
        if (errorTimeoutRef.current) {
          clearTimeout(errorTimeoutRef.current);
        }
        errorTimeoutRef.current = setTimeout(() => setError(null), 6000);
        // A request-owned job failing past retry must be visible, not silently swallowed: the
        // chip stays (marked failed) for a beat, and she acknowledges it in chat.
        const requestId = requestIdForJob(event.job);
        if (requestId) {
          director.setRequestStatus(requestId, "failed");
          refreshRequestStatuses();
          const line =
            FAILURE_LINES[failureCountRef.current % FAILURE_LINES.length];
          failureCountRef.current += 1;
          const channel: InputChannel =
            event.job.kind === "reply" ? event.job.channel : "chat";
          const now = Date.now();
          setTranscript((prev) => [
            ...prev,
            {
              id: `failure-${requestId}-${now}`,
              role: "creator",
              channel,
              text: line,
              atSec: Math.max(
                0,
                Math.floor((now - director.getState().startedAt) / 1000),
              ),
            },
          ]);
          const timeoutId = setTimeout(() => {
            failedChipTimeoutsRef.current.delete(timeoutId);
            if (currentActRef.current?.requestId === requestId) {
              currentActRef.current = null;
              refreshQueueStrip();
            }
          }, FAILED_CHIP_VISIBLE_MS);
          failedChipTimeoutsRef.current.add(timeoutId);
        }
        return;
      }
      if (event.type === "costCapReached") {
        setEndReason("costCap");
        endRef.current();
        return;
      }
      if (event.type === "clipRendered") {
        // Canon and the request chip move now; playback waits for clipReady once the swap lands.
        const rendered = event.result;
        clipMetaRef.current.set(rendered.clipId, rendered);
        if (event.lane === "chained" && currentRequestIdRef.current) {
          requestIdByClipIdRef.current.set(
            rendered.clipId,
            currentRequestIdRef.current,
          );
        }
        canonAdvancedRef.current.add(rendered.clipId);
        director.clipCompleted(rendered, Date.now());
        refreshRequestStatuses();
        pipelineRef.current?.pollChain();
        return;
      }
      if (event.type === "chainJobStarted") {
        const job = event.job;
        const owner: QueueOwner =
          job.kind === "reply"
            ? ownerForReplyJob(job)
            : currentOwnerRef.current;
        currentOwnerRef.current = owner;
        const requestId = requestIdForJob(job);
        currentRequestIdRef.current = requestId;
        currentActRef.current = {
          kind: job.kind,
          owner,
          ...(requestId ? { requestId } : {}),
        };
        if (requestId) {
          director.setRequestStatus(requestId, "generating");
          refreshRequestStatuses();
          const sentAtMs = requestSentAtMsRef.current.get(requestId);
          // Splits the fan's wait into queueing behind the current clip versus producing the reply.
          if (sentAtMs !== undefined && job.kind === "reply") {
            reportTelemetry?.("requestDispatched", {
              kind: job.kind,
              ms: Date.now() - sentAtMs,
            });
          }
        }
        if (job.kind === "reply") {
          const requestEntry = director
            .getState()
            .transcript.find((entry) => entry.id === job.requestId);
          pendingTipCentsRef.current = requestEntry?.tipCents;
        }
        // She notices the message and starts typing ~3s later; gated the same as planReply's own typing lead-in, no bubble for a rapid back-and-forth.
        if (
          job.kind === "checkIn" ||
          (job.kind === "reply" && job.precededByIdle)
        ) {
          if (typingDelayRef.current) {
            clearTimeout(typingDelayRef.current);
          }
          typingDelayRef.current = setTimeout(() => {
            typingDelayRef.current = null;
            setTypingCreator(true);
          }, 3000);
        }
        refreshQueueStrip();
        return;
      }

      const result = event.result;
      clipMetaRef.current.set(result.clipId, result);
      setCostTotal((total) => total + result.costUsd);
      setLastTimings({
        jobKind: result.jobKind,
        renderMs: result.timings.renderMs,
        costUsd: result.costUsd,
        swap: result.swap ?? null,
      });
      renderStatsTrackerRef.current.record(result.timings.renderMs);
      setRenderStats(renderStatsTrackerRef.current.snapshot());
      if (result.jobKind === "greeting") {
        setConnectStage("primingBuffer");
      }
      if (event.lane === "chained") {
        pendingTipCentsRef.current = undefined;
        // Remembered so handleClipStarted can mark this request "playing" once it's on screen.
        if (
          currentRequestIdRef.current &&
          !requestIdByClipIdRef.current.has(result.clipId)
        ) {
          requestIdByClipIdRef.current.set(
            result.clipId,
            currentRequestIdRef.current,
          );
        }
      }
      // Canon advances here (for planning); the UI's displayed state follows via handleClipStarted. A two-phase swap clip already advanced it on clipRendered.
      if (!canonAdvancedRef.current.delete(result.clipId)) {
        director.clipCompleted(result, Date.now());
      }
      refreshRequestStatuses();
      if (result.reply) {
        pendingRevealRef.current = {
          clipId: result.clipId,
          text: result.reply.text,
          channel: result.reply.channel,
          typingLeadSec: result.reply.typingLeadSec,
        };
        setTypingCreator(true);
        setTypingDevice(
          result.state.body.prop === "phone"
            ? "phone"
            : result.state.body.hands === "typing"
              ? "laptop"
              : null,
        );
      }
      pipelineRef.current?.pollChain();
      if (modeRef.current === "lucy") {
        console.info(
          `lucy pipeline: clipReady ${result.jobKind} lane=${event.lane} playerStatus=${player.getStatus()} hiddenA=${Boolean(lucyHiddenARef.current)}`,
        );
      }
      player.checkForClip();
      refreshBufferDepth();
      refreshQueueStrip();
      maybeGoLive();
    },
    [
      player,
      refreshBufferDepth,
      refreshQueueStrip,
      refreshRequestStatuses,
      maybeGoLive,
      reportTelemetry,
      setConnectStage,
    ],
  );

  // Director mode has no gapless pair to swap: the fal stream's single MediaStream is attached
  // directly to videoA and left playing; videoB stays unused (hidden by the same CSS as ever).
  const attachDirectorStream = useCallback(() => {
    const el = videoARef.current;
    const stream = directorMediaStreamRef.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    el.muted = !directorSoundOnRef.current;
    el.play().catch(() => {
      // Autoplay-with-sound blocked; fall back to muted and ask for the existing tap-to-unmute UI.
      el.muted = true;
      setNeedsTap(true);
      el.play().catch(() => {});
    });
  }, []);

  // Lucy mode's visible video shows the restyled stream, same reuse-videoA pattern as director's.
  const attachLucyStream = useCallback(() => {
    const el = videoARef.current;
    const stream = lucyMediaStreamRef.current;
    if (!el || !stream) {
      console.info(
        `lucy attach: skipped (element=${Boolean(el)} stream=${Boolean(stream)})`,
      );
      return;
    }
    // The player is not driving the visible pair here, so nothing else guarantees A is the one on top.
    el.style.opacity = "1";
    if (videoBRef.current) {
      videoBRef.current.style.opacity = "0";
    }
    if (el.srcObject !== stream) {
      el.srcObject = stream;
      el.addEventListener(
        "loadedmetadata",
        () =>
          console.info(
            `lucy attach: metadata ${el.videoWidth}x${el.videoHeight}`,
          ),
        { once: true },
      );
    }
    el.muted = !lucySoundOnRef.current;
    el.play()
      .then(() => console.info("lucy attach: playing"))
      .catch((error) => {
        console.info(`lucy attach: play blocked (${String(error)})`);
        el.muted = true;
        setNeedsTap(true);
        el.play().catch(() => {});
      });
  }, []);

  const attachVideoElements = useCallback(() => {
    if (modeRef.current === "director") {
      attachDirectorStream();
      return;
    }
    if (modeRef.current === "lucy") {
      // The hidden pipeline pair is attached separately in start(); the visible pair only ever
      // shows Lucy's own restyled stream here.
      attachLucyStream();
      return;
    }
    const a = videoARef.current;
    const b = videoBRef.current;
    if (a && b) {
      player.attach(a, b);
      player.start();
    }
  }, [player, attachDirectorStream, attachLucyStream]);

  // Off-DOM hidden video element for the lucy driving pipeline; see lucyHiddenARef.
  const createHiddenVideoElement = (): HTMLVideoElement => {
    const el = document.createElement("video");
    // Clips come from fal.media (CORS *); without this the canvas is tainted and captureStream() sends black frames.
    el.crossOrigin = "anonymous";
    el.playsInline = true;
    el.muted = true;
    el.setAttribute("aria-hidden", "true");
    el.style.position = "fixed";
    el.style.width = "2px";
    el.style.height = "2px";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    document.body.appendChild(el);
    return el;
  };

  const teardownLucyPipelineSurface = useCallback(() => {
    if (lucyRafRef.current !== null) {
      cancelAnimationFrame(lucyRafRef.current);
      lucyRafRef.current = null;
    }
    lucyHiddenARef.current?.remove();
    lucyHiddenBRef.current?.remove();
    lucyHiddenARef.current = null;
    lucyHiddenBRef.current = null;
    lucyCanvasRef.current = null;
  }, []);

  // Draws whichever hidden element the gapless player currently has active into the capture
  // canvas every frame, so canvas.captureStream() sees a continuous feed across A/B swaps.
  const startLucyCanvasDrawLoop = useCallback(() => {
    const canvas = lucyCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let drawnFrames = 0;
    const startedAt = Date.now();
    let warnedNoFrames = false;
    const draw = () => {
      const active =
        player.getActiveSlot() === "a"
          ? lucyHiddenARef.current
          : lucyHiddenBRef.current;
      if (active && active.videoWidth > 0 && active.videoHeight > 0) {
        // Cover-fit into the fixed model-sized canvas; the canvas itself never resizes.
        const scale = Math.max(
          canvas.width / active.videoWidth,
          canvas.height / active.videoHeight,
        );
        const drawWidth = active.videoWidth * scale;
        const drawHeight = active.videoHeight * scale;
        ctx.drawImage(
          active,
          (canvas.width - drawWidth) / 2,
          (canvas.height - drawHeight) / 2,
          drawWidth,
          drawHeight,
        );
        drawnFrames += 1;
        if (drawnFrames === 1) {
          console.info(
            `lucy driving: first frame clip ${active.videoWidth}x${active.videoHeight} -> canvas ${canvas.width}x${canvas.height} paused=${active.paused} readyState=${active.readyState}`,
          );
        }
      } else if (
        !warnedNoFrames &&
        Date.now() - startedAt > 15_000 &&
        drawnFrames === 0
      ) {
        warnedNoFrames = true;
        console.warn(
          `lucy driving: no frames after 15s (slot=${player.getActiveSlot()} src=${Boolean(active?.currentSrc)} readyState=${active?.readyState ?? "none"} error=${active?.error?.message ?? "none"})`,
        );
      }
      lucyRafRef.current = requestAnimationFrame(draw);
    };
    lucyRafRef.current = requestAnimationFrame(draw);
  }, [player]);

  useEffect(
    () => () => {
      player.dispose();
      pipelineRef.current?.dispose();
      directorSessionRef.current?.close();
      lucySessionRef.current?.close();
      teardownLucyPipelineSurface();
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
      }
    },
    [player, teardownLucyPipelineSurface],
  );

  useEffect(() => {
    const handleUnload = () => {
      directorSessionRef.current?.close();
      lucySessionRef.current?.close();
    };
    window.addEventListener("pagehide", handleUnload);
    return () => window.removeEventListener("pagehide", handleUnload);
  }, []);

  const bindVideoA = useCallback(
    (el: HTMLVideoElement | null) => {
      videoARef.current = el;
      attachVideoElements();
    },
    [attachVideoElements],
  );

  const bindVideoB = useCallback(
    (el: HTMLVideoElement | null) => {
      videoBRef.current = el;
      attachVideoElements();
    },
    [attachVideoElements],
  );

  const snapshotSource = useCallback(() => {
    const director = directorRef.current;
    if (!director) {
      throw new Error("Director not started");
    }
    return director.snapshot(Date.now());
  }, []);

  // The reference step (upload, look capture, staged still) is 20 to 25 s of the join; kicking it off from the setup screen hides it behind option-picking. A failure is dropped so start() retries it and reports the error itself.
  const uploadReference = deps.uploadReference;
  const warmSwap = deps.warmSwap;
  const prepare = useCallback(
    (file: File, sceneId: SceneId, stage = true) => {
      const current = preparedReferenceRef.current;
      if (
        current &&
        current.file === file &&
        current.sceneId === sceneId &&
        current.stage === stage
      ) {
        return;
      }
      // stage=false is swap mode; the swap service scales to zero, so its containers start with the upload.
      if (!stage) {
        warmSwap().catch(() => undefined);
      }
      const promise = uploadReference(file, sceneId, stage);
      const entry = { file, sceneId, stage, promise };
      preparedReferenceRef.current = entry;
      setPrepareStatus("staging");
      setPreparedSeedUrl(null);
      promise
        .then((reference) => {
          if (preparedReferenceRef.current !== entry) {
            return;
          }
          setPrepareStatus(
            reference.staged ? "ready" : stage ? "unstaged" : "uploaded",
          );
          setPreparedSeedUrl(reference.staged ? reference.seedFrameUrl : null);
        })
        .catch(() => {
          if (preparedReferenceRef.current === entry) {
            preparedReferenceRef.current = null;
            setPrepareStatus("failed");
          }
        });
    },
    [uploadReference, warmSwap],
  );

  const start = useCallback(
    async (file: File, sceneId: SceneId, options: StartOptions) => {
      setError(null);
      setStatus("connecting");
      setAcceptingRequests(false);
      setPosterUrl(null);
      connectStartedAtMsRef.current = Date.now();
      setConnectStage("uploading");
      if (connectStallTimeoutRef.current) {
        clearTimeout(connectStallTimeoutRef.current);
      }
      connectStallTimeoutRef.current = setTimeout(() => {
        connectStallTimeoutRef.current = null;
        reportTelemetry?.("connectStall", {
          stage: connectStageRef.current,
          backend: options.backend ?? "turbo",
          greetingPlayed: greetingPlayedRef.current,
          playerStatus: player.getStatus(),
          ms: CONNECT_STALL_MS,
        });
      }, CONNECT_STALL_MS);
      if (options.backend === "swap") {
        deps.warmSwap().catch(() => undefined);
      }
      greetingPlayedRef.current = false;
      clipMetaRef.current = new Map();
      currentPlayingClipIdRef.current = null;
      currentOwnerRef.current = { type: "studio" };
      currentActRef.current = null;
      currentRequestIdRef.current = null;
      requestIdByClipIdRef.current = new Map();
      requestSentAtMsRef.current = new Map();
      renderStatsTrackerRef.current = new RenderStatsTracker();
      setRenderStats(null);
      failureCountRef.current = 0;
      for (const timeoutId of failedChipTimeoutsRef.current) {
        clearTimeout(timeoutId);
      }
      failedChipTimeoutsRef.current = new Set();
      setRequestStatusesState({});
      setEndReason(null);
      pendingTipCentsRef.current = undefined;
      privateModeRef.current = false;
      setPrivateModeState(false);
      player.reset();
      // Swap mode sets the scene inside its reference-to-video greeting, so it skips the 17 to 35 s still.
      const stage = options.backend !== "swap";
      const prepared = preparedReferenceRef.current;
      const reference =
        prepared &&
        prepared.file === file &&
        prepared.sceneId === sceneId &&
        prepared.stage === stage
          ? await prepared.promise
          : await deps.uploadReference(file, sceneId, stage);
      preparedReferenceRef.current = null;
      setPrepareStatus("idle");
      setPreparedSeedUrl(null);
      setConnectStage("capturingLook");
      setPosterUrl(reference.seedFrameUrl);
      console.log(
        `useLiveSession: reference staged=${reference.staged} captured=${reference.captured}`,
      );
      const creator = defaultCreatorProfile(
        options.displayName,
        sceneId,
        reference.lookLock,
      );
      const initialLiveState = defaultLiveState(
        sceneId,
        reference.wardrobe,
        reference.surroundings,
        reference.framing,
      );

      modeRef.current =
        options.backend === "director"
          ? "director"
          : options.backend === "lucy"
            ? "lucy"
            : "clip";
      if (modeRef.current === "director") {
        applyLiveState(initialLiveState);
        setTranscript([]);
        setCostTotal(0);
        setAnchorChangedAtMs(Date.now());
        speechModeRef.current = options.speechMode ?? "text";
        setBackendState("director");
        setSpeechModeState(options.speechMode ?? "text");
        setQueueStrip(EMPTY_QUEUE_STRIP);
        setDirectorMetrics(null);
        setDirectorStreamState("opening");
        directorMediaStreamRef.current = null;
        directorSoundOnRef.current = true;
        const startedAtMs = Date.now();
        setSessionStartedAtMs(startedAtMs);
        setConnectStage("renderingFirstClip");

        const directorSession = new DirectorSession({
          openRealtime: () => openRealtimeWithFal(),
          now: () => Date.now(),
          composePrompt: deps.composeDirectorPrompt,
          onTranscriptEntry: (entry) =>
            setTranscript((prev) => [...prev, entry]),
          onRequestStatus: (requestId, requestStatus) =>
            setRequestStatusesState((prev) => ({
              ...prev,
              [requestId]: requestStatus,
            })),
          onStreamState: (state) => {
            setDirectorStreamState(state);
            if (state === "live") {
              setConnectStage("primingBuffer");
              setStatus((current) =>
                current === "connecting" ? "live" : current,
              );
            }
          },
          onMedia: (stream) => {
            directorMediaStreamRef.current = stream;
            attachDirectorStream();
          },
          onMetrics: (metrics) => {
            setDirectorMetrics(metrics);
            setCostTotal(metrics.costUsd);
          },
          onError: (message) => {
            setError(message);
            if (errorTimeoutRef.current) {
              clearTimeout(errorTimeoutRef.current);
            }
            errorTimeoutRef.current = setTimeout(() => setError(null), 6000);
          },
          onEnded: (reason) => {
            // "stopped" is the user's own end(); it already owns the status and needs no banner.
            if (reason === "stopped") return;
            setEndReason(
              reason === "maxDuration" ? "maxDuration" : "streamEnded",
            );
            setStatus("ended");
          },
          onDiagnostic: (line) => console.info(`director transport: ${line}`),
        });
        directorSessionRef.current = directorSession;

        await directorSession.open({
          creator,
          world: initialLiveState.world,
          surroundings: initialLiveState.surroundings,
          wardrobe: initialLiveState.wardrobe,
          anchorFrameUrl: reference.anchorFrameUrl,
          speechMode: options.speechMode ?? "text",
          startedAtMs,
        });

        if (tickIntervalRef.current) {
          clearInterval(tickIntervalRef.current);
        }
        tickIntervalRef.current = setInterval(() => {
          const metrics = directorSessionRef.current?.getMetricsWithCost();
          if (metrics) {
            setDirectorMetrics(metrics);
            setCostTotal(metrics.costUsd);
          }
        }, 1000);
        return;
      }

      const director = new LiveDirector({
        creator,
        anchorFrameUrl: reference.anchorFrameUrl,
        seedFrameUrl: reference.seedFrameUrl,
        liveState: initialLiveState,
        now: Date.now(),
      });
      directorRef.current = director;
      setSessionStartedAtMs(director.getState().startedAt);
      applyLiveState(initialLiveState);
      setTranscript([]);
      setCostTotal(reference.stageCostUsd);
      setAnchorChangedAtMs(Date.now());
      speechModeRef.current = options.speechMode ?? "text";
      player.setSpeechMode(speechModeRef.current);
      setBackendState(options.backend ?? "turbo");
      setSpeechModeState(options.speechMode ?? "text");

      const room = new RoomSim({ rng: createSeededRandom(Date.now()) });
      roomRef.current = room;
      setRoomEvents([]);
      setViewerCount(room.getViewerCount());
      setQueueStrip(EMPTY_QUEUE_STRIP);

      const swapRenderedClip = deps.swapRenderedClip;
      const pipeline = new ClipPipeline({
        render: deps.renderClip,
        now: () => Date.now(),
        onEvent: handlePipelineEvent,
        backend: options.backend ?? "turbo",
        speechMode: options.speechMode ?? "text",
        abandonDependents: (job) => {
          directorRef.current?.abandonRequest(requestIdForJob(job));
        },
        upscaleSeed: deps.upscaleSeed,
        needsIdentityReference: () =>
          directorRef.current?.consumeIdentityReferenceDue(Date.now()) ?? false,
        finalizeSwap:
          options.backend === "swap" && swapRenderedClip
            ? (result) => swapRenderedClip(result, reference.anchorFrameUrl)
            : undefined,
      });
      pipelineRef.current = pipeline;
      const startPipeline = () => {
        setConnectStage("renderingFirstClip");
        pipeline.start(director.nextJob(), snapshotSource, () =>
          director.nextJob(),
        );
        setAcceptingRequests(true);
      };

      if (modeRef.current === "lucy") {
        teardownLucyPipelineSurface();
        lucyHiddenARef.current = createHiddenVideoElement();
        lucyHiddenBRef.current = createHiddenVideoElement();
        player.attach(lucyHiddenARef.current, lucyHiddenBRef.current);
        player.start();
        const canvas = document.createElement("canvas");
        canvas.width = LUCY_INPUT.width;
        canvas.height = LUCY_INPUT.height;
        lucyCanvasRef.current = canvas;
        startLucyCanvasDrawLoop();
        const captureCanvas = canvas as HTMLCanvasElement & {
          webkitCaptureStream?: (frameRate?: number) => MediaStream;
        };
        const drivingStream =
          captureCanvas.captureStream?.(LUCY_INPUT.fps) ??
          captureCanvas.webkitCaptureStream?.(LUCY_INPUT.fps) ??
          new MediaStream();

        setLucyMetrics(null);
        setLucyStreamState("opening");
        lucyMediaStreamRef.current = null;
        lucySoundOnRef.current = true;
        lucyStreamCostBaseRef.current = 0;

        const lucyInput = {
          referenceImageUrl: await fetchAsDataUri(reference.anchorFrameUrl),
          prompt: buildLucyPrompt(creator.lookLock),
          drivingStream,
        };
        let lucyReopens = 0;

        // fal's gateway closes the idle signalling socket cleanly about a minute in (we send no controls after negotiation) and the SDK ends the WebRTC session with it. Reopen the same way Decart's own SDK reconnects; the cost readout keeps counting across sessions via lucyStreamCostBaseRef.
        const openLucy = (): LucySession => {
          const lucySession = new LucySession({
            fetchToken: deps.fetchLucyToken,
            openRealtime: openRealtimeWithFalLucy,
            now: () => Date.now(),
            onStreamState: (state) => {
              setLucyStreamState(state);
              if (state === "live") {
                setConnectStage("primingBuffer");
                setStatus((current) =>
                  current === "connecting" ? "live" : current,
                );
              }
            },
            onMedia: (stream) => {
              for (const track of stream.getTracks()) {
                // A remote track that stays muted means Lucy connected but is not sending frames.
                console.info(
                  `lucy media: ${track.kind} readyState=${track.readyState} muted=${track.muted}`,
                );
                track.addEventListener("unmute", () =>
                  console.info(
                    `lucy media: ${track.kind} unmuted, frames flowing`,
                  ),
                );
                track.addEventListener("mute", () =>
                  console.info(
                    `lucy media: ${track.kind} muted, frames stopped`,
                  ),
                );
              }
              lucyMediaStreamRef.current = stream;
              attachLucyStream();
            },
            onDiagnostic: (line) => console.info(`lucy transport: ${line}`),
            onError: (message) => {
              setError(message);
              if (errorTimeoutRef.current) {
                clearTimeout(errorTimeoutRef.current);
              }
              errorTimeoutRef.current = setTimeout(() => setError(null), 6000);
            },
            onEnded: (reason) => {
              if (reason === "stopped") return;
              if (
                lucySessionRef.current === lucySession &&
                shouldReopenLucy(reason, lucyReopens)
              ) {
                lucyReopens += 1;
                console.info(
                  `lucy reopen: attempt ${lucyReopens}/${LUCY_MAX_REOPENS} after ${reason}`,
                );
                lucyStreamCostBaseRef.current = 0;
                setLucyStreamState("opening");
                const next = openLucy();
                lucySessionRef.current = next;
                // Failures inside open() already flow through this session's onError/onEnded.
                next.open(lucyInput).catch(() => undefined);
                return;
              }
              setEndReason(
                reason === "maxDuration" ? "maxDuration" : "streamEnded",
              );
              setStatus("ended");
            },
          });
          return lucySession;
        };

        const lucySession = openLucy();
        lucySessionRef.current = lucySession;

        // Driving frames must already be flowing when Lucy negotiates, so the turbo pipeline starts first.
        startPipeline();
        await lucySession.open(lucyInput);
      } else {
        startPipeline();
      }

      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
      }
      tickIntervalRef.current = setInterval(() => {
        const currentDirector = directorRef.current;
        if (
          currentDirector &&
          Date.now() - currentDirector.getState().startedAt >=
            LIVE_TUNABLES.MAX_SESSION_MS
        ) {
          setEndReason("maxDuration");
          endRef.current();
          return;
        }
        currentDirector?.tick(Date.now(), { busy: isBusy() });
        pipelineRef.current?.pollChain();
        tickRoom();
        if (modeRef.current === "lucy") {
          const metrics = lucySessionRef.current?.getMetricsWithCost();
          if (metrics) {
            const delta = metrics.costUsd - lucyStreamCostBaseRef.current;
            lucyStreamCostBaseRef.current = metrics.costUsd;
            if (delta > 0) {
              setCostTotal((total) => total + delta);
            }
            setLucyMetrics(metrics);
          }
        }
      }, 1000);
    },
    [
      deps,
      handlePipelineEvent,
      player,
      reportTelemetry,
      setConnectStage,
      snapshotSource,
      applyLiveState,
      isBusy,
      tickRoom,
      attachDirectorStream,
      attachLucyStream,
      teardownLucyPipelineSurface,
      startLucyCanvasDrawLoop,
    ],
  );

  const send = useCallback(
    (text: string, channel: InputChannel, paid?: boolean) => {
      if (modeRef.current === "director") {
        // Director has no per-request tip/paid handling; the stream is steered by prompt text only.
        directorSessionRef.current?.request(text, channel);
        return;
      }
      const director = directorRef.current;
      const pipeline = pipelineRef.current;
      const trimmed = text.trim();
      if (!director || !pipeline || !trimmed) {
        return;
      }
      const sentAtMs = Date.now();
      const { entry } = director.fanRequest(
        { text: trimmed, channel, paid },
        sentAtMs,
      );
      requestSentAtMsRef.current.set(entry.id, sentAtMs);
      setTranscript((prev) => [...prev, entry]);
      pipeline.onRequestEnqueued();
      // She notices the message and starts typing about 3 s later, whatever the chain is busy with; the render of her reply follows when the lane frees.
      if (typingDelayRef.current) {
        clearTimeout(typingDelayRef.current);
      }
      typingDelayRef.current = setTimeout(() => {
        typingDelayRef.current = null;
        setTypingCreator(true);
      }, 3000);
      refreshBufferDepth();
      refreshQueueStrip();
      refreshRequestStatuses();
    },
    [refreshBufferDepth, refreshQueueStrip, refreshRequestStatuses],
  );

  const clearError = useCallback(() => {
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
    setError(null);
  }, []);

  const end = useCallback(() => {
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
    if (connectStallTimeoutRef.current) {
      clearTimeout(connectStallTimeoutRef.current);
      connectStallTimeoutRef.current = null;
    }
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
    for (const timeoutId of failedChipTimeoutsRef.current) {
      clearTimeout(timeoutId);
    }
    failedChipTimeoutsRef.current = new Set();
    clearPendingReveal();
    player.reset();
    pipelineRef.current?.dispose();
    directorRef.current = null;
    pipelineRef.current = null;
    roomRef.current = null;
    directorSessionRef.current?.close();
    directorSessionRef.current = null;
    directorMediaStreamRef.current = null;
    lucySessionRef.current?.close();
    lucySessionRef.current = null;
    lucyMediaStreamRef.current = null;
    teardownLucyPipelineSurface();
    if (videoARef.current) {
      videoARef.current.srcObject = null;
    }
    setAcceptingRequests(false);
    setStatus("ended");
  }, [clearPendingReveal, player, teardownLucyPipelineSurface]);

  useEffect(() => {
    endRef.current = end;
  }, [end]);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  const resumeAfterTap = useCallback(() => {
    if (modeRef.current === "director" || modeRef.current === "lucy") {
      // The visible element shows a live-stream MediaStream, not a GaplessPlayer clip; tap it directly.
      const el = videoARef.current;
      setNeedsTap(false);
      el?.play().catch(() => {});
      return;
    }
    player.resumeAfterTap();
  }, [player]);

  const setMuted = useCallback(
    (muted: boolean) => {
      if (modeRef.current === "director") {
        directorSoundOnRef.current = !muted;
        if (videoARef.current) {
          videoARef.current.muted = muted;
        }
        return;
      }
      if (modeRef.current === "lucy") {
        // Lucy's output is video-only (canvas.captureStream carries no audio track); tracked for
        // parity with director and a possible future audio pass-through.
        lucySoundOnRef.current = !muted;
        if (videoARef.current) {
          videoARef.current.muted = muted;
        }
        return;
      }
      player.setMuted(muted);
    },
    [player],
  );

  const setBackend = useCallback((next: RenderBackend) => {
    setBackendState(next);
    pipelineRef.current?.setBackend(next);
  }, []);

  const setSpeechMode = useCallback(
    (next: SpeechMode) => {
      speechModeRef.current = next;
      setSpeechModeState(next);
      pipelineRef.current?.setSpeechMode(next);
      player.setSpeechMode(next);
    },
    [player],
  );

  const setPrivateMode = useCallback((next: boolean) => {
    privateModeRef.current = next;
    setPrivateModeState(next);
  }, []);

  const session = useMemo(
    () => ({
      status,
      transcript,
      liveState,
      costTotal,
      bufferDepth,
      typingCreator,
      typingDevice,
      needsTap,
      acceptingRequests,
      posterUrl,
      error,
      backend,
      speechMode,
      anchorChangedAtMs,
      lastTimings,
      renderStats,
      connectStage,
      roomEvents,
      viewerCount,
      queueStrip,
      requestStatuses,
      endReason,
      offline,
      sessionStartedAtMs,
      privateMode,
      directorMetrics,
      directorStreamState,
      lucyMetrics,
      lucyStreamState,
      prepareStatus,
      preparedSeedUrl,
      prepare,
      start,
      send,
      end,
      clearError,
      resumeAfterTap,
      setMuted,
      setBackend,
      setSpeechMode,
      setPrivateMode,
    }),
    [
      status,
      transcript,
      liveState,
      costTotal,
      bufferDepth,
      typingCreator,
      typingDevice,
      needsTap,
      acceptingRequests,
      posterUrl,
      error,
      backend,
      speechMode,
      anchorChangedAtMs,
      lastTimings,
      renderStats,
      connectStage,
      roomEvents,
      viewerCount,
      queueStrip,
      requestStatuses,
      endReason,
      offline,
      sessionStartedAtMs,
      privateMode,
      directorMetrics,
      directorStreamState,
      lucyMetrics,
      lucyStreamState,
      prepareStatus,
      preparedSeedUrl,
      prepare,
      start,
      send,
      end,
      clearError,
      resumeAfterTap,
      setMuted,
      setBackend,
      setSpeechMode,
      setPrivateMode,
    ],
  );

  // Separate object: mixing a ref-shaped callback into `session` taints every read of it under react-hooks/refs.
  const videoRefs = useMemo(
    () => ({ bindVideoA, bindVideoB }),
    [bindVideoA, bindVideoB],
  );

  return [session, videoRefs] as const;
}
