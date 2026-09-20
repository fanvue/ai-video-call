"use client";

import { useState } from "react";

type BottomBarProps = {
  displayName: string;
  micArmed: boolean;
  micLabel: string;
  composerDisabled: boolean;
  composerDisabledReason: string | null;
  lastTipCoins: number;
  privateMode: boolean;
  onSend: (text: string) => void;
  onMicDown: () => void;
  onQuickTip: () => void;
  onOpenTipMenu: () => void;
  onTogglePrivate: () => void;
};

// Composer + quick actions row, separate from ChatPanel's read-only feed (matches the reference:
// a fixed input strip under a scrolling chat log, not one merged block).
export const BottomBar = ({
  displayName,
  micArmed,
  micLabel,
  composerDisabled,
  composerDisabledReason,
  lastTipCoins,
  privateMode,
  onSend,
  onMicDown,
  onQuickTip,
  onOpenTipMenu,
  onTogglePrivate,
}: BottomBarProps) => {
  const [draft, setDraft] = useState("");

  const submitDraft = () => {
    const text = draft.trim();
    if (text.length < 1 || composerDisabled) {
      return;
    }
    onSend(text);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex items-end gap-2 rounded-2xl border border-white/25 bg-white/[0.09] px-2 py-1 backdrop-blur-md"
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
          className="min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-white outline-none placeholder:text-white/50 disabled:text-white/40"
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
              ? "bg-gradient-to-b from-[#ffd21a] to-[var(--accent)] text-[var(--accent-contrast)] shadow-[0_4px_14px_rgba(255,171,0,0.4)]"
              : "border border-white/25 bg-white/10 text-white")
          }
        >
          🎙️
        </button>
        <button
          type="submit"
          aria-label="Send message"
          disabled={composerDisabled || draft.trim().length < 1}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/25 bg-white/10 text-white disabled:opacity-50"
        >
          ➤
        </button>
      </form>
      {composerDisabledReason ? (
        <p role="status" className="px-1 text-[11px] text-white/60">
          {composerDisabledReason}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={composerDisabled}
          onClick={onQuickTip}
          aria-label={`Tip ${lastTipCoins} coins`}
          className="shrink-0 rounded-full bg-gradient-to-b from-[#ffd21a] to-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-contrast)] shadow-[0_4px_14px_rgba(255,171,0,0.4)] disabled:opacity-50"
        >
          Tip {lastTipCoins}
        </button>
        <button
          type="button"
          disabled={composerDisabled}
          onClick={onOpenTipMenu}
          aria-label="Open tip menu"
          className="flex-1 rounded-full border border-white/25 bg-white/[0.06] px-3 py-2.5 text-sm font-semibold text-white backdrop-blur-md disabled:opacity-50"
        >
          🕹️ Tip menu
        </button>
      </div>
      <button
        type="button"
        onClick={onTogglePrivate}
        aria-label={privateMode ? "End private show" : "Start private show"}
        className={
          "rounded-full py-3 text-sm font-semibold " +
          (privateMode
            ? "border border-white/30 text-white"
            : "bg-white text-black")
        }
      >
        {privateMode ? "End Private Show" : "Start Private"}
      </button>
    </div>
  );
};
