"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptEntry } from "@/lib/live/contract";
import type { RoomChatMessage } from "@/lib/live/client/roomSim";
import type { TypingDevice } from "@/lib/live/client/useLiveSession";

type ChatPanelProps = {
  displayName: string;
  startedAtMs: number;
  transcript: TranscriptEntry[];
  roomEvents: RoomChatMessage[];
  typingCreator: boolean;
  typingDevice: TypingDevice;
  privateMode: boolean;
};

// One merged, time-ordered feed item for rendering; transcript entries and room events come from
// different sources (contract-shaped vs. client-only), unified here so the log can sort once.
type FeedItem =
  | {
      atMs: number;
      id: string;
      kind: "fan" | "viewer" | "creator";
      text: string;
      handle?: string;
      paid?: boolean;
      tipCents?: number;
    }
  | {
      atMs: number;
      id: string;
      kind: "chatter" | "tip" | "note";
      text: string;
      handle?: string;
      tipCents?: number;
    }
  | { atMs: number; id: string; kind: "joinLeave"; text: string };

const buildFeed = (
  startedAtMs: number,
  transcript: TranscriptEntry[],
  roomEvents: RoomChatMessage[],
  privateMode: boolean,
): FeedItem[] => {
  const fromTranscript: FeedItem[] = transcript.map((entry) => ({
    atMs: startedAtMs + entry.atSec * 1000,
    id: entry.id,
    kind: entry.role,
    text: entry.text,
    handle: entry.handle,
    paid: entry.paid,
    tipCents: entry.tipCents,
  }));
  // Private mode hides the room: only the fan's own lines and the creator's replies remain.
  if (privateMode) {
    return fromTranscript
      .filter((item) => item.kind === "fan" || item.kind === "creator")
      .sort((a, b) => a.atMs - b.atMs);
  }
  const fromRoom: FeedItem[] = roomEvents.map((event) => {
    if (event.kind === "join" || event.kind === "leave") {
      const count = event.handles?.length ?? 0;
      return {
        atMs: event.atMs,
        id: event.id,
        kind: "joinLeave",
        text: `${count} ${event.kind === "join" ? "joined" : "left"}`,
      };
    }
    return {
      atMs: event.atMs,
      id: event.id,
      kind: event.kind,
      text: event.text,
      handle: event.handle,
      tipCents: event.tipCents,
    };
  });
  return [...fromTranscript, ...fromRoom].sort((a, b) => a.atMs - b.atMs);
};

const typingLabel = (displayName: string, device: TypingDevice): string => {
  if (device === "phone") {
    return `${displayName} is typing on her phone…`;
  }
  return `${displayName} is typing…`;
};

export const ChatPanel = ({
  displayName,
  startedAtMs,
  transcript,
  roomEvents,
  typingCreator,
  typingDevice,
  privateMode,
}: ChatPanelProps) => {
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLOListElement>(null);

  const feed = useMemo(
    () => buildFeed(startedAtMs, transcript, roomEvents, privateMode),
    [startedAtMs, transcript, roomEvents, privateMode],
  );

  useEffect(() => {
    const log = logRef.current;
    if (!log || !autoScroll) {
      return;
    }
    log.scrollTo({ top: log.scrollHeight });
  }, [feed, typingCreator, autoScroll]);

  const handleScroll = () => {
    const log = logRef.current;
    if (!log) {
      return;
    }
    const distanceFromBottom =
      log.scrollHeight - log.scrollTop - log.clientHeight;
    setAutoScroll(distanceFromBottom < 24);
  };

  const jumpToLatest = () => {
    setAutoScroll(true);
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  };

  return (
    <div className="relative w-[60%] max-w-[320px]">
      <ol
        ref={logRef}
        role="log"
        aria-live="polite"
        onScroll={handleScroll}
        style={{
          maskImage: "linear-gradient(to bottom, transparent, black 24px)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent, black 24px)",
        }}
        className="flex max-h-48 flex-col gap-1.5 overflow-y-auto text-sm"
      >
        {feed.map((item) => {
          if (item.kind === "joinLeave") {
            return (
              <li key={item.id} className="text-[11px] text-white/50">
                {item.text}
              </li>
            );
          }
          if (item.kind === "note") {
            return (
              <li key={item.id} className="text-[11px] italic text-white/50">
                {item.text}
              </li>
            );
          }
          if (item.kind === "tip") {
            const initial = (item.handle ?? "?").charAt(0).toUpperCase();
            return (
              <li key={item.id}>
                <div className="flex items-center gap-2 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-2.5 py-1.5">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[11px] font-bold text-[var(--accent-contrast)]">
                    {initial}
                  </span>
                  <span className="text-[13px] text-white">
                    <span className="font-semibold">{item.handle}</span> tipped{" "}
                    <span className="font-semibold text-[var(--accent)]">
                      {item.tipCents}
                    </span>{" "}
                    for {displayName} 💛
                  </span>
                </div>
              </li>
            );
          }
          if (item.kind === "chatter") {
            return (
              <li key={item.id} className="truncate text-[13px]">
                <span className="mr-1.5 font-semibold text-white/60">
                  {item.handle}
                </span>
                <span className="text-white/80">{item.text}</span>
              </li>
            );
          }
          if (
            item.kind !== "fan" &&
            item.kind !== "viewer" &&
            item.kind !== "creator"
          ) {
            return null;
          }
          if (item.kind === "creator") {
            return (
              <li key={item.id} className="truncate text-[13px]">
                <span className="mr-1.5 font-semibold text-[var(--accent)]">
                  {displayName}
                </span>
                <span className="text-white">{item.text}</span>
              </li>
            );
          }
          if (item.kind === "fan") {
            return (
              <li key={item.id} className="truncate text-[13px]">
                <span className="mr-1.5 font-semibold text-white">you</span>
                <span className="text-white/90">{item.text}</span>
                {item.paid ? (
                  <span className="ml-1.5 rounded-full bg-[var(--accent)]/25 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--accent)]">
                    Paid
                  </span>
                ) : null}
              </li>
            );
          }
          return (
            <li key={item.id} className="truncate text-[13px]">
              <span className="mr-1.5 font-semibold text-white/60">
                {item.handle}
              </span>
              <span className="text-white/80">{item.text}</span>
            </li>
          );
        })}
        {typingCreator ? (
          <li className="text-[11px] text-white/60">
            {typingLabel(displayName, typingDevice)}
          </li>
        ) : null}
      </ol>

      {!autoScroll ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute -top-8 left-0 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white shadow"
        >
          New messages
        </button>
      ) : null}
    </div>
  );
};
