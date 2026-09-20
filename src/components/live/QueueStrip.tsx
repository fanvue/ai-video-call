import type { ClipJobKind } from "@/lib/live/contract";
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

// Reference UI shows one compact "Now: <act> for @handle" line under the top bar rather than a
// chip strip; this formats it (queued entries are still available on the session for a badge count).
export const formatQueueLabel = (
  current: QueueStripEntry | null,
  queuedCount: number,
): string | null => {
  if (!current) {
    return null;
  }
  const owner = ownerLabel(current.owner);
  const base = `Now: ${ACT_LABEL[current.kind]}${owner ? ` for ${owner}` : ""}`;
  return queuedCount > 0 ? `${base} · ${queuedCount} queued` : base;
};
