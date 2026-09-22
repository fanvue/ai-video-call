"use client";

import type { ConnectStage } from "@/lib/live/client/useLiveSession";
import { RollingNumber } from "@/components/live/RollingNumber";

type LobbyOverlayProps = {
  displayName: string;
  stage: ConnectStage;
  viewerCount: number;
  // The frame the greeting will start on, shown dimmed behind the milestones so going live is a fade, not a jump.
  posterUrl?: string | null;
};

const STAGES: { id: ConnectStage; label: string }[] = [
  { id: "uploading", label: "Uploading your reference photo" },
  { id: "capturingLook", label: "Capturing her look and staging the room" },
  { id: "renderingFirstClip", label: "Rendering the first clip" },
  { id: "primingBuffer", label: "Priming the buffer" },
];

// Shown while status === "connecting": real pipeline milestones, not a spinner.
export const LobbyOverlay = ({
  displayName,
  stage,
  viewerCount,
  posterUrl = null,
}: LobbyOverlayProps) => {
  const activeIndex = STAGES.findIndex((entry) => entry.id === stage);
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      role="status"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center"
    >
      {posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={posterUrl}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 -z-10 h-full w-full object-cover opacity-40"
        />
      ) : null}
      <span className="grid h-16 w-16 place-items-center rounded-full bg-[var(--accent)] text-2xl font-bold text-[var(--accent-contrast)]">
        {initial}
      </span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-white">{displayName}</span>
        <span className="rounded-full bg-[var(--live)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
          Live
        </span>
      </div>
      <p className="text-sm font-semibold text-white">Connecting to room…</p>
      <ul className="flex flex-col gap-1.5">
        {STAGES.map((entry, index) => (
          <li
            key={entry.id}
            aria-current={index === activeIndex ? "step" : undefined}
            className={
              "text-xs " +
              (index < activeIndex
                ? "text-white/45 line-through"
                : index === activeIndex
                  ? "text-white"
                  : "text-white/40")
            }
          >
            {entry.label}
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-1 text-xs text-white/60">
        <RollingNumber
          value={viewerCount}
          ariaLabel={`${viewerCount} ${viewerCount === 1 ? "viewer" : "viewers"}`}
        />
        <span>{viewerCount === 1 ? "viewer" : "viewers"} already here</span>
      </p>
    </div>
  );
};
