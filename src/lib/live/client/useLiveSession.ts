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

export type ReferenceUploadResult = {
  anchorFrameUrl: string;
  wardrobe: Wardrobe;
  lookLock: string;
  captured: boolean;
};

export type LiveSessionStatus =
  "connecting" | "live" | "holding" | "ended" | "error";

export type BufferDepth = { ready: number; inFlight: number };

export type StartOptions = {
  displayName: string;
  backend?: RenderBackend;
  speechMode?: SpeechMode;
};

export type UseLiveSessionDeps = {
  renderClip: (req: ClipRequest) => Promise<ClipResult>;
  uploadReference: (file: File) => Promise<ReferenceUploadResult>;
};

const playerStatusToSessionStatus = (
  status: PlayerStatus,
): LiveSessionStatus | null => {
  if (status === "playing") return "live";
  if (status === "holding") return "holding";
  return null;
};

export function useLiveSession(deps: UseLiveSessionDeps) {
  const [status, setStatus] = useState<LiveSessionStatus>("connecting");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [costTotal, setCostTotal] = useState(0);
  const [bufferDepth, setBufferDepth] = useState<BufferDepth>({
    ready: 0,
    inFlight: 0,
  });
  const [typingCreator, setTypingCreator] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackendState] = useState<RenderBackend>("turbo");
  const [speechMode, setSpeechModeState] = useState<SpeechMode>("text");

  const directorRef = useRef<LiveDirector | null>(null);
  const pipelineRef = useRef<ClipPipeline | null>(null);
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const speechModeRef = useRef<SpeechMode>("text");
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRevealRef = useRef<{
    clipId: string;
    text: string;
    channel: InputChannel;
    typingLeadSec: number;
  } | null>(null);

  const refreshBufferDepth = useCallback(() => {
    const pipeline = pipelineRef.current;
    if (!pipeline) {
      return;
    }
    setBufferDepth({
      ready: pipeline.peekReady() ? 1 : 0,
      inFlight: pipeline.isBusy() ? 1 : 0,
    });
  }, []);

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

  // Built once via lazy useState init; onProgress/onClipStarted read refs, so they're wired post-render below instead of passed here.
  const [player] = useState(
    () =>
      new GaplessPlayer({
        onStatusChange: (playerStatus) => {
          setNeedsTap(playerStatus === "needsTap");
          const mapped = playerStatusToSessionStatus(playerStatus);
          if (mapped) {
            setStatus(mapped);
          }
        },
      }),
  );

  useEffect(() => {
    player.setProgressHandler(revealIfDue);
    player.setClipStartedHandler(() => refreshBufferDepth());
  }, [player, revealIfDue, refreshBufferDepth]);

  const handlePipelineEvent = useCallback(
    (event: PipelineEvent) => {
      const director = directorRef.current;
      if (!director) {
        return;
      }
      refreshBufferDepth();
      if (event.type === "clipAbandoned") {
        setCostTotal((total) => total + event.costUsd);
        return;
      }
      if (event.type === "error") {
        setError(event.message);
        return;
      }
      if (event.type === "bufferEmpty") {
        return;
      }
      const result = event.result;
      setCostTotal((total) => total + result.costUsd);
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
      const isNative = speechModeRef.current === "native";
      player.enqueue({
        id: result.clipId,
        videoUrl: result.videoUrl,
        durationSec: result.durationSec,
        hasSpeech: isNative && result.reply !== null,
      });
    },
    [player, refreshBufferDepth],
  );

  const attachVideoElements = useCallback(() => {
    const a = videoARef.current;
    const b = videoBRef.current;
    if (a && b) {
      player.attach(a, b);
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
      const { entry, job } = director.fanRequest(
        { text: trimmed, channel, paid },
        Date.now(),
      );
      setTranscript((prev) => [...prev, entry]);
      pipeline.onRequestEnqueued(job);
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
