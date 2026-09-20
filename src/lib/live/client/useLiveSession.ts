"use client";

// Wires LiveDirector + ClipPipeline + GaplessPlayer into a React hook, and times the creator's
// typed-reply reveal to land in chat when her typing beat would actually finish on screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";
import { LiveDirector } from "@/lib/live/client/director";
import { ClipPipeline, type PipelineEvent } from "@/lib/live/client/pipeline";
import {
  GaplessPlayer,
  type ClipToPlay,
  type PlayerStatus,
} from "@/lib/live/client/gaplessPlayer";
import type {
  ClipRequest,
  ClipResult,
  InputChannel,
  LiveState,
  RenderBackend,
  SceneId,
  SpeechMode,
  TranscriptEntry,
  Wardrobe,
} from "@/lib/live/contract";
import { LIVE_TUNABLES } from "@/lib/live/contract";

export type ReferenceUploadResult = {
  anchorFrameUrl: string;
  wardrobe: Wardrobe;
  lookLock: string;
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

  const directorRef = useRef<LiveDirector | null>(null);
  const pipelineRef = useRef<ClipPipeline | null>(null);
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const speechModeRef = useRef<SpeechMode>("text");
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const greetingPlayedRef = useRef(false);
  // Maps a rendered clip's id to what it was, so the player's onClipStarted (id only) can look
  // up job kind / reply for chat-sync and the connecting -> live transition.
  const clipMetaRef = useRef<Map<string, ClipResult>>(new Map());
  const pendingRevealRef = useRef<{
    clipId: string;
    text: string;
    channel: InputChannel;
    typingLeadSec: number;
  } | null>(null);

  const clearPendingReveal = useCallback(() => {
    pendingRevealRef.current = null;
    setTypingCreator(false);
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
    };
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

  const maybeGoLive = useCallback(() => {
    const pipeline = pipelineRef.current;
    if (!pipeline || !greetingPlayedRef.current) {
      return;
    }
    const stats = pipeline.getBufferStats();
    if (stats.idleReady + stats.chainedReady >= LIVE_TUNABLES.PRIME_CLIPS) {
      setStatus((current) => (current === "connecting" ? "live" : current));
    }
  }, []);

  const handleClipStarted = useCallback(
    (clipId: string) => {
      refreshBufferDepth();
      const meta = clipMetaRef.current.get(clipId);
      if (meta?.jobKind === "greeting") {
        greetingPlayedRef.current = true;
        maybeGoLive();
      }
    },
    [maybeGoLive, refreshBufferDepth],
  );

  useEffect(() => {
    player.setProgressHandler(revealIfDue);
    player.setClipStartedHandler(handleClipStarted);
    player.setNextClipHandler(getNextClip);
  }, [player, revealIfDue, handleClipStarted, getNextClip]);

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
        refreshBufferDepth();
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
      // The director owns job sequencing (followUps, settle); it must update before the pipeline
      // is polled again, and pollChain() below runs synchronously after this returns.
      director.clipCompleted(result, Date.now());
      setLiveState(result.state);
      if (result.reply) {
        pendingRevealRef.current = {
          clipId: result.clipId,
          text: result.reply.text,
          channel: result.reply.channel,
          typingLeadSec: result.reply.typingLeadSec,
        };
        setTypingCreator(true);
      }
      pipelineRef.current?.pollChain();
      player.checkForClip();
      refreshBufferDepth();
      maybeGoLive();
    },
    [player, refreshBufferDepth, maybeGoLive],
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
      greetingPlayedRef.current = false;
      clipMetaRef.current = new Map();
      player.reset();
      const reference = await deps.uploadReference(file);
      const creator = defaultCreatorProfile(
        options.displayName,
        sceneId,
        reference.lookLock,
      );
      const initialLiveState = defaultLiveState(sceneId, reference.wardrobe);
      const director = new LiveDirector({
        creator,
        anchorFrameUrl: reference.anchorFrameUrl,
        seedFrameUrl: reference.anchorFrameUrl,
        liveState: initialLiveState,
        now: Date.now(),
      });
      directorRef.current = director;
      setLiveState(initialLiveState);
      setTranscript([]);
      setCostTotal(0);
      setAnchorChangedAtMs(Date.now());
      speechModeRef.current = options.speechMode ?? "text";
      player.setSpeechMode(speechModeRef.current);
      setBackendState(options.backend ?? "turbo");
      setSpeechModeState(options.speechMode ?? "text");

      const pipeline = new ClipPipeline({
        render: deps.renderClip,
        now: () => Date.now(),
        onEvent: handlePipelineEvent,
        backend: options.backend ?? "turbo",
        speechMode: options.speechMode ?? "text",
      });
      pipelineRef.current = pipeline;

      pipeline.start(director.nextJob(), snapshotSource, () =>
        director.nextJob(),
      );

      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
      }
      tickIntervalRef.current = setInterval(() => {
        directorRef.current?.tick(Date.now());
        pipelineRef.current?.pollChain();
      }, 1000);
    },
    [deps, handlePipelineEvent, player, snapshotSource],
  );

  const send = useCallback(
    (text: string, channel: InputChannel, paid?: boolean) => {
      const director = directorRef.current;
      const pipeline = pipelineRef.current;
      const trimmed = text.trim();
      if (!director || !pipeline || !trimmed) {
        return;
      }
      const { entry } = director.fanRequest(
        { text: trimmed, channel, paid },
        Date.now(),
      );
      setTranscript((prev) => [...prev, entry]);
      pipeline.onRequestEnqueued();
      refreshBufferDepth();
    },
    [refreshBufferDepth],
  );

  const end = useCallback(() => {
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
    clearPendingReveal();
    player.reset();
    pipelineRef.current?.dispose();
    directorRef.current = null;
    pipelineRef.current = null;
    setStatus("ended");
  }, [clearPendingReveal, player]);

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

  const session = useMemo(
    () => ({
      status,
      transcript,
      liveState,
      costTotal,
      bufferDepth,
      typingCreator,
      needsTap,
      error,
      backend,
      speechMode,
      anchorChangedAtMs,
      lastTimings,
      start,
      send,
      end,
      resumeAfterTap,
      setMuted,
      setBackend,
      setSpeechMode,
    }),
    [
      status,
      transcript,
      liveState,
      costTotal,
      bufferDepth,
      typingCreator,
      needsTap,
      error,
      backend,
      speechMode,
      anchorChangedAtMs,
      lastTimings,
      start,
      send,
      end,
      resumeAfterTap,
      setMuted,
      setBackend,
      setSpeechMode,
    ],
  );

  // Separate object: mixing a ref-shaped callback into `session` taints every read of it under react-hooks/refs.
  const videoRefs = useMemo(
    () => ({ bindVideoA, bindVideoB }),
    [bindVideoA, bindVideoB],
  );

  return [session, videoRefs] as const;
}
