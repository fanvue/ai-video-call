"use client";

const PRIVATE_START_COINS = 72;
const PRIVATE_PER_MINUTE_COINS = 24;
const PRIVATE_MIN_MINUTES = 3;

// Which catalog actions are still being finished; shown with a COMING SOON tag in the sheet.
const COMING_SOON_IDS = new Set(["blowjob-toy", "vibrator-play"]);

type IncludedAction = { id: string; label: string; emoji: string };

type PrivateShowSheetProps = {
  open: boolean;
  displayName: string;
  balance: number;
  includedActions: IncludedAction[];
  onClose: () => void;
  onStart: () => void;
};

// Starting a private show is a client-only presentation state (see useLiveSession's privateMode):
// it stops the room sim and swaps the header, but the live engine underneath keeps running.
export const PrivateShowSheet = ({
  open,
  displayName,
  balance,
  includedActions,
  onClose,
  onStart,
}: PrivateShowSheetProps) => {
  if (!open) {
    return null;
  }
  const canStart = balance >= PRIVATE_START_COINS;
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full flex-col gap-3 overflow-y-auto rounded-t-2xl bg-[var(--surface)] pt-2 pb-[max(16px,env(safe-area-inset-bottom))]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2">
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            Private show
          </h2>
          <button
            type="button"
            aria-label="Close private show details"
            onClick={onClose}
            className="text-lg text-[var(--foreground)]"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-3 px-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-lg font-bold text-[var(--accent-contrast)]">
            {initial}
          </span>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-[var(--foreground)]">
              {displayName}
            </span>
            <span className="text-xs text-[var(--muted)]">
              ⭐ 4.7 · 128 ratings
            </span>
          </div>
        </div>

        <p className="px-4 text-sm font-medium text-[var(--foreground)]">
          Start · {PRIVATE_PER_MINUTE_COINS}/min · Minimum {PRIVATE_MIN_MINUTES}{" "}
          minutes · {PRIVATE_START_COINS} coins to start · you have {balance}
        </p>

        <p className="px-4 text-sm text-[var(--foreground)]">
          Every action on the menu is included
        </p>
        <p className="px-4 text-xs text-[var(--muted)]">
          A private show pauses the public room. {displayName} responds only to
          you until you end it, billed per minute in coins from your balance.
          This is a demo: no real payment is taken.
        </p>

        <ul className="flex flex-col gap-1 px-4">
          {includedActions.map((action) => (
            <li
              key={action.id}
              className="flex items-center gap-2 text-sm text-[var(--foreground)]"
            >
              <span>{action.emoji}</span>
              <span className="flex-1">{action.label}</span>
              {COMING_SOON_IDS.has(action.id) ? (
                <span className="rounded bg-[var(--surface-raised)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)]">
                  Coming soon
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="px-4">
          <button
            type="button"
            disabled={!canStart}
            onClick={onStart}
            aria-label="Start private show"
            className="w-full rounded-full bg-white py-3 text-sm font-semibold text-black disabled:opacity-50"
          >
            Start Private Show
          </button>
          {!canStart ? (
            <p className="mt-1.5 text-center text-xs text-[var(--danger)]">
              You need {PRIVATE_START_COINS - balance} more coins to start.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export const PRIVATE_SHOW_START_COINS = PRIVATE_START_COINS;
export const PRIVATE_SHOW_PER_MINUTE_COINS = PRIVATE_PER_MINUTE_COINS;
