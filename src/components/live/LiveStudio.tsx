"use client";

import { useCallback, useEffect, useState } from "react";
import { renderClip, uploadReference } from "@/lib/live/client/api";
import { DEFAULT_TIP_MENU } from "@/lib/live/client/defaultCreatorProfile";
import { useLiveSession } from "@/lib/live/client/useLiveSession";
import { ChatPanel } from "@/components/live/ChatPanel";
import { SetupScreen, type SetupSubmit } from "@/components/live/SetupScreen";
import { StatusPill } from "@/components/live/StatusPill";
import { StudioOverlay } from "@/components/live/StudioOverlay";
import { TipMenuDrawer } from "@/components/live/TipMenuDrawer";
import { useVoiceInput } from "@/components/live/useVoiceInput";

const formatElapsed = (startedAtMs: number, nowMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export const LiveStudio = () => {
  const [phase, setPhase] = useState<"setup" | "live">("setup");
  const [displayName, setDisplayName] = useState("Her");
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [tipMenuOpen, setTipMenuOpen] = useState(false);
  const [studioMode, setStudioMode] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [session, videoRefs] = useLiveSession({ renderClip, uploadReference });
  const { bindVideoA, bindVideoB } = videoRefs;

  const handleSend = useCallback(
    (text: string, paid?: boolean) => {
      session.send(text, "chat", paid);
    },
    [session],
  );

  const voice = useVoiceInput((text) => session.send(text, "voice"));

  const handleMicDown = useCallback(() => {
    voice.start();
  }, [voice]);

  const handleSubmitSetup = useCallback(
    (values: SetupSubmit) => {
      setStarting(true);
      setStartError(null);
      setDisplayName(values.displayName || "Her");
      session
        .start(values.file, values.sceneId, {
          displayName: values.displayName || "Her",
          backend: values.backend,
          speechMode: values.speechMode,
        })
        .then(() => {
          setStartedAtMs(Date.now());
          setPhase("live");
        })
        .catch((e: unknown) => {
          setStartError(
            e instanceof Error ? e.message : "Could not start the call.",
          );
        })
        .finally(() => setStarting(false));
    },
    [session],
  );

  const handleEnd = useCallback(() => {
    voice.stop();
    session.end();
    setPhase("setup");
    setEndConfirmOpen(false);
    setStartedAtMs(null);
  }, [session, voice]);

  const toggleSound = useCallback(() => {
    setSoundOn((current) => {
      const next = !current;
      session.setMuted(!next);
      return next;
    });
  }, [session]);

  useEffect(() => {
    if (phase !== "live" || startedAtMs === null) {
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase, startedAtMs]);

  if (phase === "setup") {
    return (
      <SetupScreen
        busy={starting}
        error={startError}
        onSubmit={handleSubmitSetup}
      />
    );
  }

  return (
    <div className="relative mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden bg-black">
      <div className="relative min-h-0 flex-1 bg-black">
        <video
          ref={bindVideoA}
          playsInline
          disablePictureInPicture
          className="absolute inset-0 h-full w-full object-cover"
        />
        <video
          ref={bindVideoB}
          playsInline
          disablePictureInPicture
          className="absolute inset-0 h-full w-full object-cover opacity-0"
        />

        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">
              {displayName}
            </span>
            <StatusPill status={session.status} />
            <span className="text-xs text-white/70">
              {startedAtMs !== null ? formatElapsed(startedAtMs, now) : "00:00"}
            </span>
          </div>
          <button
            type="button"
            aria-label="End call"
            onClick={() => setEndConfirmOpen(true)}
            className="grid h-9 w-9 place-items-center rounded-full bg-black/40 text-white"
          >
            ✕
          </button>
        </div>

        <div className="absolute inset-x-0 top-14 flex justify-end gap-2 px-3">
          <button
            type="button"
            aria-label="Toggle studio panel"
            aria-pressed={studioMode}
            onClick={() => setStudioMode((v) => !v)}
            className={
              "rounded-full px-3 py-1 text-xs font-medium " +
              (studioMode ? "bg-white text-black" : "bg-black/40 text-white")
            }
          >
            Studio
          </button>
          <button
            type="button"
            aria-label={soundOn ? "Mute" : "Unmute"}
            aria-pressed={soundOn}
            onClick={toggleSound}
            className="grid h-8 w-8 place-items-center rounded-full bg-black/40 text-white"
          >
            {soundOn ? "🔊" : "🔇"}
          </button>
        </div>

        {studioMode ? (
          <div className="absolute inset-x-3 top-24">
            <StudioOverlay
              liveState={session.liveState}
              bufferDepth={session.bufferDepth}
              costTotal={session.costTotal}
              anchorChangedAtMs={session.anchorChangedAtMs}
              lastTimings={session.lastTimings}
              nowMs={now}
            />
          </div>
        ) : null}

        {session.needsTap ? (
          <button
            type="button"
            onClick={session.resumeAfterTap}
            className="absolute inset-x-3 bottom-32 rounded-full bg-white py-3 text-sm font-semibold text-black"
          >
            Tap for sound
          </button>
        ) : null}

        {session.error ? (
          <p
            role="status"
            className="absolute left-1/2 top-1/3 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-sm text-white"
          >
            {session.error}
          </p>
        ) : null}
        {voice.micError ? (
          <p
            role="status"
            className="absolute left-1/2 top-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-sm text-white"
          >
            {voice.micError}
          </p>
        ) : null}

        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          <ChatPanel
            displayName={displayName}
            transcript={session.transcript}
            typingCreator={session.typingCreator}
            micArmed={voice.micArmed}
            micLabel={voice.micArmed ? "Listening" : "Turn mic on"}
            onSend={(text) => handleSend(text)}
            onMicDown={handleMicDown}
          />
          <button
            type="button"
            onClick={() => setTipMenuOpen(true)}
            className="rounded-full border border-white/30 py-3 text-sm font-semibold text-white"
          >
            Tip menu
          </button>
        </div>
      </div>

      <TipMenuDrawer
        open={tipMenuOpen}
        items={DEFAULT_TIP_MENU.map((item) => ({ ...item }))}
        onClose={() => setTipMenuOpen(false)}
        onPick={(item) => {
          setTipMenuOpen(false);
          handleSend(item.request, true);
        }}
      />

      {endConfirmOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60">
          <div className="flex w-[min(90vw,320px)] flex-col gap-3 rounded-2xl bg-[var(--surface)] p-5">
            <h2 className="text-base font-semibold text-[var(--foreground)]">
              End the call?
            </h2>
            <button
              type="button"
              onClick={handleEnd}
              className="rounded-full bg-white py-3 text-sm font-semibold text-black"
            >
              End call
            </button>
            <button
              type="button"
              onClick={() => setEndConfirmOpen(false)}
              className="rounded-full border border-white/30 py-3 text-sm font-semibold text-white"
            >
              Keep talking
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
