"use client";

import type { ClipJobKind } from "@/lib/live/contract";
import type {
  QueueOwner,
  QueueStripEntry,
} from "@/lib/live/client/useLiveSession";

type QueueStripProps = {
  current: QueueStripEntry | null;
  queued: QueueStripEntry[];
};

const ACT_LABEL: Record<ClipJobKind, string> = {
  greeting: "Saying hi",
  idle: "Just chatting",
  checkIn: "Checking in",
  reply: "Replying",
  beat: "Following through",
  settle: "Settling back",
  redress: "Getting dressed",
};

const ownerLabel = (owner: QueueOwner): string | null => {
  if (owner.type === "fan") {
    return "you";
  }
  if (owner.type === "viewer") {
    return `@${owner.handle}`;
  }
  return null;
};

const Chip = ({ entry, muted }: { entry: QueueStripEntry; muted: boolean }) => {
  const owner = ownerLabel(entry.owner);
  return (
    <span
      className={
        "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium " +
        (muted ? "bg-black/30 text-white/60" : "bg-black/50 text-white")
      }
    >
      {ACT_LABEL[entry.kind]}
      {owner ? <span className="ml-1 text-white/70">· {owner}</span> : null}
    </span>
  );
};

// Shows what's playing now and what's queued behind it, so the fan sees when the creator is
// serving someone else in the room instead of them.
export const QueueStrip = ({ current, queued }: QueueStripProps) => {
  if (!current && queued.length === 0) {
    return null;
  }
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-1 pb-1">
      {current ? <Chip entry={current} muted={false} /> : null}
      {queued.map((entry, index) => (
        <Chip key={`${entry.kind}-${index}`} entry={entry} muted />
      ))}
    </div>
  );
};
