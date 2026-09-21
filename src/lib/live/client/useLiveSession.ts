"use client";

// Wires LiveDirector + ClipPipeline + GaplessPlayer into a React hook, and times the creator's
// typed-reply reveal to land in chat when her typing beat would actually finish on screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";
import { LiveDirector, type RequestStatus } from "@/lib/live/client/director";
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
  uploadReference: (file: File) => Promise<ReferenceUploadResult>;
  upscaleSeed?: (
    frameUrl: string,
  ) => Promise<{ url: string | null; costUsd: number }>;
};

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
  const [connectStage, setConnectStage] = useState<ConnectStage>("uploading");
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
    setStatus((current) => (current === "connecting" ? "live" : current));
  }, []);

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
          console.log(
            `useLiveSession: request-to-first-visible-frame requestId=${requestId} ms=${Date.now() - sentAtMs}`,
          );
          requestSentAtMsRef.current.delete(requestId);
        }
      }
      refreshBufferDepth();
      greetingPlayedRef.current = true;
      maybeGoLive();
    },
    [applyLiveState, maybeGoLive, refreshBufferDepth, refreshRequestStatuses],
  );

  useEffect(() => {
    player.setProgressHandler(revealIfDue);
    player.setClipStartedHandler(handleClipStarted);
    player.setNextClipHandler(getNextClip);
    player.setInterruptReadyHandler(hasInterruptReady);
    player.setClipReturnedHandler(returnClip);
  }, [
    player,
    revealIfDue,
    handleClipStarted,
    getNextClip,
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
      });
      renderStatsTrackerRef.current.record(result.timings.renderMs);
      setRenderStats(renderStatsTrackerRef.current.snapshot());
      if (result.jobKind === "greeting") {
        setConnectStage("primingBuffer");
      }
      if (event.lane === "chained") {
        pendingTipCentsRef.current = undefined;
        // Remembered so handleClipStarted can mark this request "playing" once it's on screen.
        if (currentRequestIdRef.current) {
          requestIdByClipIdRef.current.set(
            result.clipId,
            currentRequestIdRef.current,
          );
        }
      }
      // Canon advances here (for planning); the UI's displayed state follows via handleClipStarted.
      director.clipCompleted(result, Date.now());
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

  const start = useCallback(
    async (file: File, sceneId: SceneId, options: StartOptions) => {
      setError(null);
      setStatus("connecting");
      setConnectStage("uploading");
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
      const reference = await deps.uploadReference(file);
      setConnectStage("capturingLook");
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
        seedFrameUrl: reference.anchorFrameUrl,
        liveState: initialLiveState,
        now: Date.now(),
      });
      directorRef.current = director;
      setSessionStartedAtMs(director.getState().startedAt);
      applyLiveState(initialLiveState);
      setTranscript([]);
      setCostTotal(0);
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
      });
      pipelineRef.current = pipeline;

      setConnectStage("renderingFirstClip");
      pipeline.start(director.nextJob(), snapshotSource, () =>
        director.nextJob(),
      );

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
