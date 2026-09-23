"use client";

import type { LiveState } from "@/lib/live/contract";
import type {
  BufferDepth,
  StudioTimings,
} from "@/lib/live/client/useLiveSession";
import type { RenderPercentiles } from "@/lib/live/client/renderStats";
import type {
  DirectorMetrics,
  DirectorRealtimeState,
} from "@/lib/live/client/directorStream";
import type {
  LucyMetrics,
  LucyRealtimeState,
} from "@/lib/live/client/lucyStream";
import type {
  LongLiveMetrics,
  LongLiveStreamState,
} from "@/lib/live/client/longliveStream";

type StudioOverlayProps = {
  liveState: LiveState | null;
  bufferDepth: BufferDepth;
  costTotal: number;
  anchorChangedAtMs: number | null;
  lastTimings: StudioTimings | null;
  renderStats: RenderPercentiles | null;
  nowMs: number;
  // Director-only; absent (null) for turbo/reference sessions.
  directorMetrics?: DirectorMetrics | null;
  directorStreamState?: DirectorRealtimeState | null;
  // Lucy-only; absent (null) outside lucy mode.
  lucyMetrics?: LucyMetrics | null;
  lucyStreamState?: LucyRealtimeState | null;
  // LongLive-only; absent (null) outside longlive mode.
  longliveMetrics?: LongLiveMetrics | null;
  longliveStreamState?: LongLiveStreamState | null;
};

const similarity = (value: number | null): string =>
  value === null ? "-" : value.toFixed(2);

const wardrobeSummary = (liveState: LiveState): string =>
  (["top", "bottom", "bra", "panties"] as const)
    .filter((garment) => !liveState.wardrobe[garment].on)
    .map((garment) => garment)
    .join(", ") || "fully dressed";

// Creator/crew-facing debug readout; fans never see this (gated behind the "Studio" toggle).
export const StudioOverlay = ({
  liveState,
  bufferDepth,
  costTotal,
  anchorChangedAtMs,
  lastTimings,
  renderStats,
  nowMs,
  directorMetrics,
  directorStreamState,
  lucyMetrics,
  lucyStreamState,
  longliveMetrics,
  longliveStreamState,
}: StudioOverlayProps) => {
  const anchorAgeSec =
    anchorChangedAtMs !== null
      ? Math.max(0, Math.round((nowMs - anchorChangedAtMs) / 1000))
      : null;

  if (directorMetrics) {
    const phases = directorMetrics.sessionMetrics
      ? Object.entries(directorMetrics.sessionMetrics)
          .map(
            ([phase, stats]) =>
              `${phase} ${stats.p50Ms ?? "-"}/${stats.p95Ms ?? "-"}ms`,
          )
          .join(", ")
      : "-";
    return (
      <div className="flex flex-col gap-1 rounded-xl bg-black/60 px-3 py-2 text-[11px] text-white/80">
        <p className="m-0">
          Director stream: {directorStreamState ?? "-"} · Chunks{" "}
          {directorMetrics.chunkCount} · Buffer{" "}
          {directorMetrics.bufferDepthSec ?? "-"}s · Slack{" "}
          {directorMetrics.lastSchedulingSlackMs ?? "-"}ms · Missed{" "}
          {directorMetrics.deadlineMissedCount}
        </p>
        <p className="m-0">
          Session p50/p95: {phases} · Spent $
          {directorMetrics.costUsd.toFixed(2)}
        </p>
      </div>
    );
  }

  if (longliveMetrics) {
    return (
      <div className="flex flex-col gap-1 rounded-xl bg-black/60 px-3 py-2 text-[11px] text-white/80">
        <p className="m-0">
          LongLive stream: {longliveStreamState ?? "-"} · Gen{" "}
          {longliveMetrics.genFps?.toFixed(1) ?? "-"} fps · Block{" "}
          {longliveMetrics.blockMs ?? "-"}ms · Decode{" "}
          {longliveMetrics.decodeMs ?? "-"}ms · Server queue{" "}
          {longliveMetrics.serverQueueFrames ?? "-"}f
        </p>
        <p className="m-0">
          Buffered {longliveMetrics.bufferedFrames}f · Rate{" "}
          {longliveMetrics.playbackRate.toFixed(2)}x · Underruns{" "}
          {longliveMetrics.underruns} · Dropped {longliveMetrics.droppedFrames}{" "}
          · Reconnects {longliveMetrics.reconnects}
        </p>
        <p className="m-0">
          Load {longliveMetrics.loadMs ?? "-"}ms · First frame{" "}
          {longliveMetrics.firstFrameMs ?? "-"}ms · Painted{" "}
          {longliveMetrics.framesPainted} · Spent $
          {longliveMetrics.costUsd.toFixed(2)}
        </p>
      </div>
    );
  }

  if (lucyMetrics) {
    return (
      <div className="flex flex-col gap-1 rounded-xl bg-black/60 px-3 py-2 text-[11px] text-white/80">
        <p className="m-0">
          Lucy stream: {lucyStreamState ?? "-"} · Spent $
          {lucyMetrics.costUsd.toFixed(2)}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-xl bg-black/60 px-3 py-2 text-[11px] text-white/80">
      <p className="m-0">
        Off: {liveState ? wardrobeSummary(liveState) : "-"} · Pose:{" "}
        {liveState?.body.pose ?? "-"} · Prop: {liveState?.body.prop ?? "-"}
      </p>
      <p className="m-0">
        Anchor age: {anchorAgeSec ?? "-"}s · Idle {bufferDepth.idleReady}
        ready / {bufferDepth.idleInflight} rendering · Chain{" "}
        {bufferDepth.chainedReady} ready · Buffered{" "}
        {bufferDepth.bufferedSec.toFixed(1)}s
      </p>
      <p className="m-0">
        Last: {lastTimings ? lastTimings.jobKind : "-"} ·{" "}
        {lastTimings ? `${lastTimings.renderMs}ms` : "-"} ·{" "}
        {lastTimings ? `$${lastTimings.costUsd.toFixed(3)}` : "-"} · Spent $
        {costTotal.toFixed(2)}
      </p>
      <p className="m-0">
        Render p50/p95:{" "}
        {renderStats
          ? `${renderStats.p50}ms / ${renderStats.p95}ms (n=${renderStats.count})`
          : "-"}
      </p>
      {lastTimings?.swap ? (
        <p className="m-0">
          Swap:{" "}
          {lastTimings.swap.status === "swapped"
            ? `${lastTimings.swap.frames}f in ${lastTimings.swap.swapMs}ms (${lastTimings.swap.msPerFrame}ms/f) · face ${lastTimings.swap.framesWithFace}/${lastTimings.swap.frames} · id ${similarity(lastTimings.swap.similarityBefore)} → ${similarity(lastTimings.swap.similarityAfter)}${lastTimings.swap.restored ? " · restored" : ""}`
            : `failed after ${lastTimings.swap.swapMs}ms (${lastTimings.swap.reason ?? "unknown"})`}
        </p>
      ) : null}
    </div>
  );
};
