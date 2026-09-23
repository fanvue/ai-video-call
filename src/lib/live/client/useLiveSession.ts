"use client";

// Wires LiveDirector + ClipPipeline + GaplessPlayer into a React hook, and times the creator's
// typed-reply reveal to land in chat when her typing beat would actually finish on screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";
import { LiveDirector, type RequestStatus } from "@/lib/live/client/director";
import {
  fetchClipSource,
  releaseClipSource,
} from "@/lib/live/client/clipSource";
import { ClipPipeline, type PipelineEvent } from "@/lib/live/client/pipeline";
import { createEarlySwaps } from "@/lib/live/client/earlySwaps";
import type { SwapFrameRange } from "@/lib/live/client/api";
import {
  type PendingReveal,
  replyRevealDue,
} from "@/lib/live/client/replyReveal";
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
  // Head-only crop of the upload; absent when the swap service could not crop it.
  identityFrameUrl?: string;
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
  | "connecting"
  | "live"
  | "holding"
  | "ended"
  | "error";

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
  // Swap mode only: Advanced's Face lock toggle, off by default; see swapRecipeFor.
  swapFaceLock?: boolean;
  // Swap mode only: Advanced's Hand mask toggle, off by default.
  swapHandMask?: boolean;
  // Swap mode only: the manifest persona id the swap uses as its source, never an image.
  swapPersonaId?: string;
};

export type UseLiveSessionDeps = {
  renderClip: (
    req: ClipRequest,
    onRendered?: (videoUrl: string) => void,
  ) => Promise<ClipResult>;
  uploadReference: (
    file: File,
    sceneId: SceneId,
    stage?: boolean,
  ) => Promise<ReferenceUploadResult>;
  upscaleSeed?: (
    frameUrl: string,
  ) => Promise<{ url: string | null; costUsd: number }>;
  // Swap mode only; starts the GPU container before the first clip needs it.
  warmSwap: () => Promise<void>;
  // Swap mode only: second phase of a clip that came back with swap.status "pending".
  swapRenderedClip?: (
    result: Pick<ClipResult, "videoUrl" | "jobKind">,
    personaId: string | undefined,
    swapFaceLock?: boolean,
    swapHandMask?: boolean,
    range?: SwapFrameRange,
  ) => Promise<{ videoUrl: string; costUsd: number; report: ClipSwapReport }>;
  // Optional: playback and connect events for the server log; tests leave it out.
  reportTelemetry?: (
    event: string,
    detail: Record<string, string | number | boolean | null>,
  ) => void;
};

// Staging state of the reference step started from the setup screen: "unstaged" is a completed step whose still was refused or failed, so the greeting starts on the photo.
export type PrepareStatus =
  | "idle"
  | "staging"
  | "ready"
  | "uploaded"
  | "unstaged"
  | "failed";

// A join that has not shown the greeting by now is the "stuck in connecting" report; log where it stalled.
const CONNECT_STALL_MS = 60_000;
// A 3 MB clip downloads in well under a second; past this it streams instead of holding the swap.
const CLIP_PREFETCH_TIMEOUT_MS = 6_000;
// About 3 MB each; more than the shelf ever holds playable at once in swap mode.
const PREFETCH_MAX_CLIPS = 4;

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
  | "uploading"
  | "capturingLook"
  | "renderingFirstClip"
  | "primingBuffer";

export type QueueOwner =
  | { type: "fan" }
  | { type: "viewer"; handle: string }
  | { type: "studio" };

// `requestId` is only set for a reply/beat job (a request-owned act); it's what the failed-chip
// timeout and the "playing" transition key off.
export type QueueStripEntry = {
  kind: ClipJobKind;
  owner: QueueOwner;
  requestId?: string;
};

export type TypingDevice = "laptop" | "phone" | null;

export type SessionEndReason = "maxDuration" | "costCap" | null;

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

  const directorRef = useRef<LiveDirector | null>(null);
  const pipelineRef = useRef<ClipPipeline | null>(null);
  const roomRef = useRef<RoomSim | null>(null);
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const speechModeRef = useRef<SpeechMode>("text");
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const greetingPlayedRef = useRef(false);
  // Clip ids whose canon already advanced on clipRendered (two-phase swap), so clipReady does not advance it twice.
  const canonAdvancedRef = useRef(new Set<string>());
  // Swap mode: downloads started when a clip's swap landed, taken by the player's next preload of that URL. A stable Map, not a ref, because the player's lazy init closes over it.
  const [prefetchedSources] = useState(
    () => new Map<string, Promise<string>>(),
  );
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
  const pendingRevealRef = useRef<PendingReveal | null>(null);

  const clearPendingReveal = useCallback(() => {
    pendingRevealRef.current = null;
    setTypingCreator(false);
    setTypingDevice(null);
  }, []);

  const appendReply = useCallback(
    (pending: PendingReveal) => {
      const director = directorRef.current;
      if (!director) {
        return;
      }
      pendingRevealRef.current = null;
      setTypingCreator(false);
      setTypingDevice(null);
      const now = Date.now();
      // The chat half of the fan's wait, next to requestVisible's video half.
      if (pending.sentAtMs !== undefined) {
        reportTelemetry?.("replyRevealed", {
          clipId: pending.clipId,
          held: pending.holdForAction,
          ms: now - pending.sentAtMs,
        });
      }
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
    },
    [reportTelemetry],
  );

  const revealIfDue = useCallback(
    (currentTimeSec: number, clipId: string) => {
      const pending = pendingRevealRef.current;
      if (!pending || !directorRef.current) {
        return;
      }
      const meta = clipMetaRef.current.get(clipId);
      const due = replyRevealDue(
        pending,
        {
          clipId,
          currentTimeSec,
          requestId: requestIdByClipIdRef.current.get(clipId) ?? null,
          setupOnly: meta?.setupOnly === true,
          idle: meta?.jobKind === "idle",
        },
        Date.now(),
      );
      if (due) {
        appendReply(pending);
      }
    },
    [appendReply],
  );

  const getNextClip = useCallback((): ClipToPlay | null => {
    const pipeline = pipelineRef.current;
    if (!pipeline) {
      return null;
    }
    const result = pipeline.nextClip();
    if (!result) {
      return null;
    }
    clipMetaRef.current.set(result.clipId, result);
    const requestId = requestIdByClipIdRef.current.get(result.clipId);
    const sentAtMs =
      requestId === undefined
        ? undefined
        : requestSentAtMsRef.current.get(requestId);
    return {
      id: result.clipId,
      videoUrl: result.videoUrl,
      durationSec: result.durationSec,
      hasSpeech: speechModeRef.current === "native" && result.reply !== null,
      loops: result.loops,
      interrupts: result.jobKind !== "idle",
      startSec: pipeline.startSecFor(result.clipId),
      ...(sentAtMs === undefined
        ? {}
        : { visibleByMs: sentAtMs + LIVE_TUNABLES.CUT_IN_VISIBLE_BY_MS }),
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
        resolveSource: async (url) => {
          const prefetched = prefetchedSources.get(url);
          prefetchedSources.delete(url);
          const src = await (prefetched ??
            fetchClipSource(url, CLIP_PREFETCH_TIMEOUT_MS));
          if (src === url) {
            deps.reportTelemetry?.("clipPrefetchFallback", {});
          }
          return src;
        },
        releaseSource: releaseClipSource,
        onStall: (detail) => deps.reportTelemetry?.("videoStall", detail),
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
    const queued = director.getState().jobQueue.map(
      (job): QueueStripEntry => ({
        kind: job.kind,
        owner:
          job.kind === "reply"
            ? ownerForReplyJob(job)
            : currentOwnerRef.current,
      }),
    );
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
        pipelineRef.current?.onClipStarted(result.seedFrameUrl, clipId);
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
      // Download each swapped clip as soon as it lands instead of when the player pulls it, so a clip that lands after a boundary plays about a second sooner (prod: 1.3 to 2.3 s from swap landed to on screen).
      if (
        result.swap !== undefined &&
        !prefetchedSources.has(result.videoUrl)
      ) {
        prefetchedSources.set(
          result.videoUrl,
          fetchClipSource(result.videoUrl, CLIP_PREFETCH_TIMEOUT_MS),
        );
        // Bounded so clips that never play (session end, a dropped filler) cannot pile up blobs.
        for (const [url, pending] of prefetchedSources) {
          if (prefetchedSources.size <= PREFETCH_MAX_CLIPS) {
            break;
          }
          prefetchedSources.delete(url);
          void pending.then(releaseClipSource);
        }
      }
      // A split reply's rest: playable and prefetched like any clip, but its head already carried canon, the reply and the render cost.
      if (event.type === "clipPartReady") {
        setCostTotal((total) => total + result.costUsd);
        player.checkForClip();
        refreshBufferDepth();
        return;
      }
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
        const held = pendingRevealRef.current;
        // A held reply whose clip already played still belongs in chat before the next one.
        if (held?.holdForAction && held.replySeen) {
          appendReply(held);
        }
        pendingRevealRef.current = {
          clipId: result.clipId,
          requestId: requestIdByClipIdRef.current.get(result.clipId) ?? null,
          text: result.reply.text,
          channel: result.reply.channel,
          typingLeadSec: result.reply.typingLeadSec,
          holdForAction: result.setupOnly === true,
          replySeen: false,
          readyAtMs: Date.now(),
          sentAtMs: requestSentAtMsRef.current.get(
            requestIdByClipIdRef.current.get(result.clipId) ?? "",
          ),
        };
        const { sentAtMs } = pendingRevealRef.current;
        // Splits requestVisible into the swap landing and the download plus cut-in after it.
        if (sentAtMs !== undefined) {
          reportTelemetry?.("replyLanded", {
            clipId: result.clipId,
            ms: Date.now() - sentAtMs,
          });
        }
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
      player.checkForClip();
      refreshBufferDepth();
      refreshQueueStrip();
      maybeGoLive();
    },
    [
      appendReply,
      player,
      prefetchedSources,
      refreshBufferDepth,
      refreshQueueStrip,
      refreshRequestStatuses,
      maybeGoLive,
      reportTelemetry,
      setConnectStage,
    ],
  );

  const attachVideoElements = useCallback(() => {
    const a = videoARef.current;
    const b = videoBRef.current;
    if (a && b) {
      player.attach(a, b);
      player.start();
    }
  }, [player]);

  useEffect(
    () => () => {
      player.dispose();
      pipelineRef.current?.dispose();
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
      }
    },
    [player],
  );

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

      const director = new LiveDirector({
        creator,
        anchorFrameUrl: reference.anchorFrameUrl,
        identityFrameUrl: reference.identityFrameUrl,
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
      const runSwap = swapRenderedClip
        ? (
            clip: Pick<ClipResult, "videoUrl" | "jobKind">,
            range?: SwapFrameRange,
          ) =>
            swapRenderedClip(
              clip,
              options.swapPersonaId,
              options.swapFaceLock,
              options.swapHandMask,
              range,
            )
        : null;
      // The head and the rest each take a container; with fewer free, the reply swaps whole rather than queue inside Modal.
      const reserveSplitSlot = () => {
        const current = pipelineRef.current;
        return current &&
          current.swapLoad() + 2 <= LIVE_TUNABLES.SWAP_SERVICE_CONTAINERS
          ? current.holdSwapSlot()
          : null;
      };
      const earlySwaps = runSwap
        ? createEarlySwaps(
            runSwap,
            LIVE_TUNABLES.SWAP_SPLIT_REPLY
              ? {
                  headFrames: LIVE_TUNABLES.SWAP_SPLIT_HEAD_FRAMES,
                  greetingHeadFrames:
                    LIVE_TUNABLES.SWAP_SPLIT_GREETING_HEAD_FRAMES,
                  reserve: reserveSplitSlot,
                }
              : undefined,
          )
        : null;
      // Start a reply's (and the greeting's) full swap from the clip route's render stream instead of after its seed swap, taking that 2 to 4 s off the wait; at most one such early swap runs, outside the pipeline's swap slots.
      const earlyReplySwaps =
        options.backend === "swap" &&
        earlySwaps !== null &&
        LIVE_TUNABLES.SWAP_DEFER_CLIP;
      const pipeline = new ClipPipeline({
        render: earlyReplySwaps
          ? (req) => {
              const kind = req.job.kind;
              return deps.renderClip(
                req,
                kind === "reply" || kind === "greeting"
                  ? (videoUrl) => earlySwaps.start(videoUrl, kind)
                  : undefined,
              );
            }
          : deps.renderClip,
        now: () => Date.now(),
        onEvent: handlePipelineEvent,
        backend: options.backend ?? "turbo",
        speechMode: options.speechMode ?? "text",
        swapFaceLock: options.swapFaceLock,
        swapHandMask: options.swapHandMask,
        personaId: options.swapPersonaId,
        abandonDependents: (job) => {
          directorRef.current?.abandonRequest(requestIdForJob(job));
        },
        upscaleSeed: deps.upscaleSeed,
        needsIdentityReference: () =>
          directorRef.current?.consumeIdentityReferenceDue(Date.now()) ?? false,
        finalizeSwap:
          options.backend === "swap" && runSwap
            ? (result) => {
                const early = earlySwaps?.take(result);
                const rest = earlySwaps?.takeRest(result);
                if (!early) {
                  return runSwap(result);
                }
                return rest ? early.then((head) => ({ ...head, rest })) : early;
              }
            : undefined,
      });
      pipelineRef.current = pipeline;
      setConnectStage("renderingFirstClip");
      pipeline.start(director.nextJob(), snapshotSource, () =>
        director.nextJob(),
      );
      setAcceptingRequests(true);

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
    ],
  );

  const send = useCallback(
    (text: string, channel: InputChannel, paid?: boolean) => {
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
    setAcceptingRequests(false);
    setStatus("ended");
  }, [clearPendingReveal, player]);

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
    player.resumeAfterTap();
  }, [player]);

  const setMuted = useCallback(
    (muted: boolean) => {
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
