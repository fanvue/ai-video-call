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
  micArmed: boolean;
  micLabel: string;
  composerDisabled: boolean;
  composerDisabledReason: string | null;
  onSend: (text: string) => void;
  onMicDown: () => void;
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
  if (device === "laptop") {
    return `${displayName} is typing…`;
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
  micArmed,
  micLabel,
  composerDisabled,
  composerDisabledReason,
  onSend,
  onMicDown,
}: ChatPanelProps) => {
  const [draft, setDraft] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLOListElement>(null);

  const feed = useMemo(
    () => buildFeed(startedAtMs, transcript, roomEvents),
    [startedAtMs, transcript, roomEvents],
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

  const submitDraft = () => {
    const text = draft.trim();
    if (text.length < 1 || composerDisabled) {
      return;
    }
    onSend(text);
    setDraft("");
    setAutoScroll(true);
  };

  return (
    <div className="relative flex flex-col gap-2">
      <ol
        ref={logRef}
        role="log"
        aria-live="polite"
        onScroll={handleScroll}
        className="flex max-h-40 flex-col gap-1.5 overflow-y-auto text-sm"
      >
        {feed.map((item) => {
          if (item.kind === "joinLeave") {
            return (
              <li
                key={item.id}
                className="self-center text-[11px] text-[var(--muted)]"
              >
                {item.text}
              </li>
            );
          }
          if (item.kind === "note") {
            return (
              <li
                key={item.id}
                className="self-center text-[11px] italic text-[var(--muted)]"
              >
                {item.text}
              </li>
            );
          }
          if (item.kind === "chatter" || item.kind === "tip") {
            return (
              <li key={item.id} className="self-start pr-10">
                <div className="flex items-baseline gap-1.5 rounded-2xl bg-[var(--surface)] px-3 py-1.5 text-[var(--muted)]">
                  <span className="text-xs font-semibold text-[var(--muted)]">
                    {item.handle}
                  </span>
                  <span>{item.text}</span>
                  {item.kind === "tip" && item.tipCents !== undefined ? (
                    <span className="rounded-full bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--accent)]">
                      tipped ${(item.tipCents / 100).toFixed(2)}
                    </span>
                  ) : null}
                </div>
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
          const isCreator = item.kind === "creator";
          return (
            <li
              key={item.id}
              className={isCreator ? "self-start pr-10" : "self-end pl-10"}
            >
              <div
                className={
                  "rounded-2xl px-3 py-1.5 " +
                  (isCreator
                    ? "bg-[var(--surface-raised)] text-[var(--foreground)]"
                    : item.kind === "viewer"
                      ? "bg-[var(--surface)] text-[var(--muted)]"
                      : "bg-[var(--accent)] text-[var(--accent-contrast)]")
                }
              >
                {item.kind === "viewer" ? (
                  <span className="mr-1.5 text-xs font-semibold">
                    {item.handle}
                  </span>
                ) : null}
                <span>{item.text}</span>
                {item.paid ? (
                  <span className="ml-2 rounded-full bg-black/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                    Paid
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
        {typingCreator ? (
          <li className="self-start pr-10 text-xs text-[var(--muted)]">
            {typingLabel(displayName, typingDevice)}
          </li>
        ) : null}
      </ol>

      {!autoScroll ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute -top-9 left-1/2 -translate-x-1/2 rounded-full bg-[var(--surface-raised)] px-3 py-1 text-xs font-medium text-[var(--foreground)] shadow"
        >
          New messages
        </button>
      ) : null}

      <form
        className="flex items-end gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <textarea
          rows={1}
          value={draft}
          maxLength={300}
          disabled={composerDisabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitDraft();
            }
          }}
          placeholder={composerDisabledReason ?? `Message ${displayName}…`}
          aria-label={`Message ${displayName}`}
          aria-disabled={composerDisabled}
          className="min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-[var(--foreground)] outline-none disabled:text-[var(--muted)]"
        />
        <button
          type="button"
          aria-label={micLabel}
          aria-pressed={micArmed}
          disabled={composerDisabled}
          onPointerDown={onMicDown}
          className={
            "grid h-9 w-9 shrink-0 place-items-center rounded-full text-base disabled:opacity-50 " +
            (micArmed
              ? "bg-[var(--accent)] text-[var(--accent-contrast)]"
              : "bg-[var(--surface-raised)] text-[var(--foreground)]")
          }
        >
          🎙️
        </button>
        <button
          type="submit"
          aria-label="Send message"
          disabled={composerDisabled || draft.trim().length < 1}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--surface-raised)] text-[var(--foreground)] disabled:opacity-50"
        >
          ➤
        </button>
      </form>
      {composerDisabledReason ? (
        <p role="status" className="px-1 text-[11px] text-[var(--muted)]">
          {composerDisabledReason}
        </p>
      ) : null}
    </div>
  );
};
