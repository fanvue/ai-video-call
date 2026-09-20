"use client";

import type { LiveState } from "@/lib/live/contract";
import type { BufferDepth } from "@/lib/live/client/useLiveSession";

type StudioOverlayProps = {
  liveState: LiveState | null;
  bufferDepth: BufferDepth;
  costTotal: number;
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
}: StudioOverlayProps) => (
  <div className="flex flex-col gap-1 rounded-xl bg-black/60 px-3 py-2 text-[11px] text-white/80">
    <p className="m-0">
      Off: {liveState ? wardrobeSummary(liveState) : "-"} · Pose:{" "}
      {liveState?.body.pose ?? "-"} · Prop: {liveState?.body.prop ?? "-"}
    </p>
    <p className="m-0">
      Buffer: {bufferDepth.ready} ready / {bufferDepth.inFlight} rendering ·
      Spent ${costTotal.toFixed(2)}
    </p>
  </div>
);
