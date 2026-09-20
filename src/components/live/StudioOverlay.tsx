"use client";

import type { LiveState } from "@/lib/live/contract";
import type {
  BufferDepth,
  StudioTimings,
} from "@/lib/live/client/useLiveSession";

type StudioOverlayProps = {
  liveState: LiveState | null;
  bufferDepth: BufferDepth;
  costTotal: number;
  anchorChangedAtMs: number | null;
  lastTimings: StudioTimings | null;
  nowMs: number;
};

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
  nowMs,
}: StudioOverlayProps) => {
  const anchorAgeSec =
    anchorChangedAtMs !== null
      ? Math.max(0, Math.round((nowMs - anchorChangedAtMs) / 1000))
      : null;

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
    </div>
  );
};
