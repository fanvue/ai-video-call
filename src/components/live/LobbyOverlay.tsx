"use client";

import type { ConnectStage } from "@/lib/live/client/useLiveSession";

type LobbyOverlayProps = {
  stage: ConnectStage;
  viewerCount: number;
};

const STAGES: { id: ConnectStage; label: string }[] = [
  { id: "uploading", label: "Uploading your reference photo" },
  { id: "capturingLook", label: "Capturing her look" },
  { id: "renderingFirstClip", label: "Rendering the first clip" },
  { id: "primingBuffer", label: "Priming the buffer" },
];

// Shown while status === "connecting": real pipeline milestones, not a spinner.
export const LobbyOverlay = ({ stage, viewerCount }: LobbyOverlayProps) => {
  const activeIndex = STAGES.findIndex((entry) => entry.id === stage);
  return (
    <div
      role="status"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center"
    >
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
      <p className="text-xs text-white/60">
        {viewerCount} {viewerCount === 1 ? "viewer" : "viewers"} already here
      </p>
    </div>
  );
};
