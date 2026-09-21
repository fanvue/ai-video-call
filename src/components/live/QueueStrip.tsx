import type { ClipJobKind } from "@/lib/live/contract";
import type { RequestStatus } from "@/lib/live/client/director";
import type {
  QueueOwner,
  QueueStripEntry,
} from "@/lib/live/client/useLiveSession";

const ACT_LABEL: Record<ClipJobKind, string> = {
  greeting: "Saying hi",
  idle: "Just chatting",
  checkIn: "Checking in",
  reply: "Replying",
  beat: "Following through",
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

// One compact "Now: <act> for @handle" line; a failed request stays here (not cleared) for ~6s.
export const formatQueueLabel = (
  current: QueueStripEntry | null,
  queuedCount: number,
  status?: RequestStatus,
): string | null => {
  if (!current) {
    return null;
  }
  const owner = ownerLabel(current.owner);
  if (status === "failed") {
    return `Couldn't finish that one${owner ? ` for ${owner}` : ""} — retry?`;
  }
  const base = `Now: ${ACT_LABEL[current.kind]}${owner ? ` for ${owner}` : ""}`;
  return queuedCount > 0 ? `${base} · ${queuedCount} queued` : base;
};
