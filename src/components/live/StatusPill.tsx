"use client";

import type { LiveSessionStatus } from "@/lib/live/client/useLiveSession";

const LABEL: Record<LiveSessionStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  holding: "Buffering",
  ended: "Ended",
  error: "Reconnecting",
};

export const StatusPill = ({ status }: { status: LiveSessionStatus }) => (
  <span
    role="status"
    className={
      "rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide " +
      (status === "live"
        ? "bg-[var(--live)] text-white"
        : "bg-black/40 text-white")
    }
  >
    {LABEL[status]}
  </span>
);
