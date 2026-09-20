"use client";

import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "@/lib/live/contract";

type ChatPanelProps = {
  displayName: string;
  transcript: TranscriptEntry[];
  typingCreator: boolean;
  micArmed: boolean;
  micLabel: string;
  onSend: (text: string) => void;
  onMicDown: () => void;
};

export const ChatPanel = ({
  displayName,
  transcript,
  typingCreator,
  micArmed,
  micLabel,
  onSend,
  onMicDown,
}: ChatPanelProps) => {
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [transcript, typingCreator]);

  return (
    <div className="flex flex-col gap-2">
      <ol
        ref={logRef}
        role="log"
        aria-live="polite"
        className="flex max-h-40 flex-col gap-1.5 overflow-y-auto text-sm"
      >
        {transcript.map((entry) => (
          <li
            key={entry.id}
            className={
              entry.role === "creator" ? "self-start pr-10" : "self-end pl-10"
            }
          >
            <div
              className={
                "rounded-2xl px-3 py-1.5 " +
                (entry.role === "creator"
                  ? "bg-[var(--surface-raised)] text-[var(--foreground)]"
                  : "bg-[var(--accent)] text-[var(--accent-contrast)]")
              }
            >
              <span>{entry.text}</span>
              {entry.paid ? (
                <span className="ml-2 rounded-full bg-black/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                  Paid
                </span>
              ) : null}
            </div>
          </li>
        ))}
        {typingCreator ? (
          <li className="self-start pr-10 text-xs text-[var(--muted)]">
            {displayName} is typing…
          </li>
        ) : null}
      </ol>

      <form
        className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (text.length < 1) {
            return;
          }
          onSend(text);
          setDraft("");
        }}
      >
        <input
          type="text"
          value={draft}
          maxLength={300}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Message ${displayName}…`}
          aria-label={`Message ${displayName}`}
          className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm text-[var(--foreground)] outline-none"
        />
        <button
          type="button"
          aria-label={micLabel}
          aria-pressed={micArmed}
          onPointerDown={onMicDown}
          className={
            "grid h-9 w-9 shrink-0 place-items-center rounded-full text-base " +
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
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--surface-raised)] text-[var(--foreground)]"
        >
          ➤
        </button>
      </form>
    </div>
  );
};
