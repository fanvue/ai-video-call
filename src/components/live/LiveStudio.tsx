"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  composeDirectorPrompt,
  fetchLucyToken,
  renderClip,
  reportTelemetry,
  swapRenderedClip,
  uploadReference,
  upscaleSeed,
  warmSwap,
} from "@/lib/live/client/api";
import {
  DEFAULT_TIP_MENU,
  type TipMenuAction,
} from "@/lib/live/client/defaultCreatorProfile";
import {
  addCoins,
  coinsToBecomeTopFan,
  COIN_PACKS,
  createWalletState,
  recordTip,
  spendCoins,
} from "@/lib/live/client/coins";
import { useLiveSession } from "@/lib/live/client/useLiveSession";
import { BottomBar } from "@/components/live/BottomBar";
import { ChatPanel } from "@/components/live/ChatPanel";
import { formatQueueLabel } from "@/components/live/QueueStrip";
import { GetCoinsSheet } from "@/components/live/GetCoinsSheet";
import { LobbyOverlay } from "@/components/live/LobbyOverlay";
import {
  PRIVATE_SHOW_PER_MINUTE_COINS,
  PRIVATE_SHOW_START_COINS,
  PrivateShowSheet,
} from "@/components/live/PrivateShowSheet";
import { SetupScreen, type SetupSubmit } from "@/components/live/SetupScreen";
import { StudioOverlay } from "@/components/live/StudioOverlay";
import { TipMenuDrawer } from "@/components/live/TipMenuDrawer";
import { TopBar } from "@/components/live/TopBar";
import { useVoiceInput } from "@/components/live/useVoiceInput";

const PRIVATE_METER_INTERVAL_MS = 60_000;
const DEFAULT_LAST_TIP_COINS = 10;

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
  const [getCoinsOpen, setGetCoinsOpen] = useState(false);
  const [privateShowOpen, setPrivateShowOpen] = useState(false);
  const [studioMode, setStudioMode] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [wallet, setWallet] = useState(() => createWalletState());
  const [lastTipCoins, setLastTipCoins] = useState(DEFAULT_LAST_TIP_COINS);
  const [debugMode] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("debug") === "1",
  );

  const [session, videoRefs] = useLiveSession({
    renderClip,
    uploadReference,
    upscaleSeed,
    composeDirectorPrompt,
    fetchLucyToken,
    warmSwap,
    swapRenderedClip,
    reportTelemetry,
  });
  const { bindVideoA, bindVideoB } = videoRefs;

  const processedTipEventIdsRef = useRef<Set<string>>(new Set());
  const privateMeterIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  // Every room-sim tip (ambient viewer or the fan's own via a viewer-request echo) feeds the
  // shared goal and crown exactly once, tracked by RoomChatMessage id.
  useEffect(() => {
    const unseen = session.roomEvents.filter(
      (event) =>
        event.kind === "tip" &&
        event.tipCents !== undefined &&
        !processedTipEventIdsRef.current.has(event.id),
    );
    if (unseen.length === 0) {
      return;
    }
    for (const event of unseen) {
      processedTipEventIdsRef.current.add(event.id);
    }
    setWallet((current) =>
      unseen.reduce(
        (wallet, event) =>
          recordTip(wallet, event.handle ?? "viewer", event.tipCents ?? 0),
        current,
      ),
    );
  }, [session.roomEvents]);

  const stopPrivateMeter = useCallback(() => {
    if (privateMeterIntervalRef.current) {
      clearInterval(privateMeterIntervalRef.current);
      privateMeterIntervalRef.current = null;
    }
  }, []);

  const endPrivateShow = useCallback(() => {
    stopPrivateMeter();
    session.setPrivateMode(false);
  }, [session, stopPrivateMeter]);

  // Per-minute coin meter for private mode: a local demo billing tick, not a real charge. Ends
  // the show automatically once the fan's balance can't cover the next minute.
  useEffect(() => {
    if (!session.privateMode) {
      return;
    }
    privateMeterIntervalRef.current = setInterval(() => {
      setWallet((current) => {
        if (current.balance < PRIVATE_SHOW_PER_MINUTE_COINS) {
          endPrivateShow();
          return current;
        }
        return spendCoins(current, PRIVATE_SHOW_PER_MINUTE_COINS);
      });
    }, PRIVATE_METER_INTERVAL_MS);
    return stopPrivateMeter;
  }, [session.privateMode, endPrivateShow, stopPrivateMeter]);

  useEffect(() => stopPrivateMeter, [stopPrivateMeter]);

  // The director queues fan requests (insertReplyIndex) rather than dropping extras, so the
  // composer only blocks until the pipeline exists; a request sent during the intro plays after the greeting.
  const composerDisabled =
    session.status === "connecting" && !session.acceptingRequests;
  const composerDisabledReason = composerDisabled ? "Connecting…" : null;

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
          swapProfile: values.swapProfile,
          intentParser: values.intentParser,
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
    stopPrivateMeter();
    session.end();
    setPhase("setup");
    setEndConfirmOpen(false);
    setStartedAtMs(null);
  }, [session, voice, stopPrivateMeter]);

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

  const handleAutoEnd = useCallback(() => {
    voice.stop();
    stopPrivateMeter();
    setPhase("setup");
    setStartedAtMs(null);
    if (session.endReason === "costCap") {
      setStartError("Session ended: spending cap reached ($8.00).");
    } else if (session.endReason === "maxDuration") {
      setStartError("Session ended: max session length reached.");
    } else if (session.endReason === "streamEnded") {
      setStartError("Session ended: the live stream ended.");
    }
  }, [voice, stopPrivateMeter, session.endReason]);

  // Syncs local UI to a session that ended itself (spend cap, max duration), not derived state.
  useEffect(() => {
    if (session.status !== "ended" || phase !== "live") {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    handleAutoEnd();
  }, [session.status, phase, handleAutoEnd]);

  const handlePickTipMenuItem = useCallback(
    (item: TipMenuAction) => {
      setTipMenuOpen(false);
      setWallet((current) => spendCoins(current, item.priceCents));
      setLastTipCoins(item.priceCents);
      handleSend(item.request, true);
    },
    [handleSend],
  );

  const handleQuickTip = useCallback(() => {
    setWallet((current) => spendCoins(current, lastTipCoins));
    handleSend(`tips ${lastTipCoins} coins`, true);
  }, [handleSend, lastTipCoins]);

  const handleBuyCoins = useCallback((pack: (typeof COIN_PACKS)[number]) => {
    setWallet((current) => addCoins(current, pack.coins));
  }, []);

  const handleTogglePrivate = useCallback(() => {
    if (session.privateMode) {
      endPrivateShow();
      return;
    }
    setPrivateShowOpen(true);
  }, [session.privateMode, endPrivateShow]);

  const handleStartPrivateShow = useCallback(() => {
    if (wallet.balance < PRIVATE_SHOW_START_COINS) {
      return;
    }
    setWallet((current) => spendCoins(current, PRIVATE_SHOW_START_COINS));
    session.setPrivateMode(true);
    setPrivateShowOpen(false);
  }, [session, wallet.balance]);

  const nowPlayingLabel = formatQueueLabel(
    session.queueStrip.current,
    session.queueStrip.queued.length,
    session.queueStrip.current?.requestId
      ? session.requestStatuses[session.queueStrip.current.requestId]
      : undefined,
  );

  const includedActions = useMemo(
    () =>
      DEFAULT_TIP_MENU.map((item) => ({
        id: item.id,
        label: item.label,
        emoji: item.emoji,
      })),
    [],
  );

  if (phase === "setup") {
    return (
      <SetupScreen
        busy={starting}
        error={startError}
        onPrepare={session.prepare}
        preparation={{
          status: session.prepareStatus,
          seedUrl: session.preparedSeedUrl,
        }}
        onSubmit={handleSubmitSetup}
      />
    );
  }

  return (
    <div className="relative mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden bg-black">
      {debugMode ? (
        // Sits in the unused viewport margin beside the mobile-width player on desktop; hidden below lg.
        <div className="fixed right-4 top-20 z-40 hidden w-52 flex-col gap-1 rounded-xl border border-white/15 bg-black/70 p-3 font-mono text-[11px] text-white/80 lg:flex">
          <p className="text-white">
            Total cost: ${session.costTotal.toFixed(3)}
          </p>
          <p>
            Idle ready {session.bufferDepth.idleReady} / inflight{" "}
            {session.bufferDepth.idleInflight}
          </p>
          <p>Chained ready {session.bufferDepth.chainedReady}</p>
          <p>Buffered {session.bufferDepth.bufferedSec.toFixed(1)}s</p>
          {session.lastTimings ? (
            <p>
              Last {session.lastTimings.jobKind}: {session.lastTimings.renderMs}
              ms / ${session.lastTimings.costUsd.toFixed(3)}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="relative isolate min-h-0 flex-1 bg-black">
        <video
          ref={bindVideoA}
          playsInline
          disablePictureInPicture
          className="absolute inset-0 h-full w-full object-cover transition-[opacity,filter] duration-150"
        />
        <video
          ref={bindVideoB}
          playsInline
          disablePictureInPicture
          className="absolute inset-0 h-full w-full object-cover transition-[opacity,filter] duration-150"
        />

        <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent">
          <TopBar
            displayName={displayName}
            status={session.status}
            elapsed={
              startedAtMs !== null ? formatElapsed(startedAtMs, now) : "00:00"
            }
            costUsd={session.costTotal}
            viewerCount={session.viewerCount}
            privateMode={session.privateMode}
            goal={wallet.goal}
            coinBalance={wallet.balance}
            topFan={wallet.topFan}
            nowPlayingLabel={nowPlayingLabel}
            onTipClick={() => setTipMenuOpen(true)}
            onGetCoinsClick={() => setGetCoinsOpen(true)}
          />
          <div className="flex items-center justify-end gap-2 px-3 pb-2">
            {debugMode ? (
              <button
                type="button"
                aria-label="Toggle studio panel"
                aria-pressed={studioMode}
                onClick={() => setStudioMode((v) => !v)}
                className={
                  "rounded-full px-3 py-1 text-xs font-medium " +
                  (studioMode
                    ? "bg-white text-black"
                    : "bg-black/40 text-white")
                }
              >
                Studio
              </button>
            ) : null}
            <button
              type="button"
              aria-label={soundOn ? "Mute" : "Unmute"}
              aria-pressed={soundOn}
              onClick={toggleSound}
              className="grid h-8 w-8 place-items-center rounded-full border border-white/25 bg-white/10 text-white backdrop-blur-md"
            >
              {soundOn ? "🔊" : "🔇"}
            </button>
            <button
              type="button"
              aria-label="End call"
              onClick={() => setEndConfirmOpen(true)}
              className="grid h-9 w-9 place-items-center rounded-full border border-white/25 bg-white/10 text-white backdrop-blur-md"
            >
              ✕
            </button>
          </div>
        </div>

        {debugMode && studioMode ? (
          <div className="absolute inset-x-3 top-40">
            <StudioOverlay
              liveState={session.liveState}
              bufferDepth={session.bufferDepth}
              costTotal={session.costTotal}
              anchorChangedAtMs={session.anchorChangedAtMs}
              lastTimings={session.lastTimings}
              renderStats={session.renderStats}
              nowMs={now}
              directorMetrics={session.directorMetrics}
              directorStreamState={session.directorStreamState}
              lucyMetrics={session.lucyMetrics}
              lucyStreamState={session.lucyStreamState}
            />
          </div>
        ) : null}

        {session.status === "connecting" ? (
          <LobbyOverlay
            displayName={displayName}
            stage={session.connectStage}
            viewerCount={session.viewerCount}
            posterUrl={session.posterUrl}
          />
        ) : null}

        {session.needsTap ? (
          <button
            type="button"
            onClick={session.resumeAfterTap}
            className="absolute inset-x-3 bottom-40 rounded-full bg-white py-3 text-sm font-semibold text-black"
          >
            Tap for sound
          </button>
        ) : null}

        {session.offline ? (
          <p
            role="status"
            className="absolute inset-x-3 top-24 rounded-full bg-[var(--danger)]/80 px-3 py-1.5 text-center text-sm text-white"
          >
            You are offline. We will reconnect automatically.
          </p>
        ) : null}

        {session.error ? (
          <div
            role="status"
            className="absolute left-1/2 top-1/3 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-sm text-white"
          >
            <span>{session.error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={session.clearError}
              className="text-white/70"
            >
              ✕
            </button>
          </div>
        ) : null}
        {voice.micError ? (
          <p
            role="status"
            className="absolute left-1/2 top-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-sm text-white"
          >
            {voice.micError}
          </p>
        ) : null}

        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/80 to-transparent p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          <ChatPanel
            displayName={displayName}
            startedAtMs={session.sessionStartedAtMs ?? now}
            transcript={session.transcript}
            roomEvents={session.roomEvents}
            typingCreator={session.typingCreator}
            typingDevice={session.typingDevice}
            privateMode={session.privateMode}
          />
          <BottomBar
            displayName={displayName}
            micArmed={voice.micArmed}
            micLabel={voice.micArmed ? "Listening" : "Turn mic on"}
            composerDisabled={composerDisabled}
            composerDisabledReason={composerDisabledReason}
            lastTipCoins={lastTipCoins}
            privateMode={session.privateMode}
            onSend={(text) => handleSend(text)}
            onMicDown={handleMicDown}
            onQuickTip={handleQuickTip}
            onOpenTipMenu={() => setTipMenuOpen(true)}
            onTogglePrivate={handleTogglePrivate}
          />
          <p className="px-1 text-center text-[10px] leading-tight text-white/45">
            This is an AI interactive show. The character, her videos and her
            chat replies are AI-generated.
          </p>
        </div>
      </div>

      <TipMenuDrawer
        open={tipMenuOpen}
        items={DEFAULT_TIP_MENU}
        balance={wallet.balance}
        coinsToTopFan={coinsToBecomeTopFan(wallet)}
        onClose={() => setTipMenuOpen(false)}
        onPick={handlePickTipMenuItem}
        onGetCoins={() => {
          setTipMenuOpen(false);
          setGetCoinsOpen(true);
        }}
      />

      <GetCoinsSheet
        open={getCoinsOpen}
        balance={wallet.balance}
        packs={COIN_PACKS}
        onClose={() => setGetCoinsOpen(false)}
        onBuy={handleBuyCoins}
      />

      <PrivateShowSheet
        open={privateShowOpen}
        displayName={displayName}
        balance={wallet.balance}
        includedActions={includedActions}
        onClose={() => setPrivateShowOpen(false)}
        onStart={handleStartPrivateShow}
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
