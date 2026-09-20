"use client";

import type { TipMenuAction } from "@/lib/live/client/defaultCreatorProfile";

type TipMenuDrawerProps = {
  open: boolean;
  items: TipMenuAction[];
  balance: number;
  coinsToTopFan: number;
  onClose: () => void;
  onPick: (item: TipMenuAction) => void;
  onGetCoins: () => void;
};

// Tapping an item spends its coin price locally and sends its catalog phrase through
// session.send(request, "chat", true); real payment execution stays outside this demo.
export const TipMenuDrawer = ({
  open,
  items,
  balance,
  coinsToTopFan,
  onClose,
  onPick,
  onGetCoins,
}: TipMenuDrawerProps) => {
  if (!open) {
    return null;
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex w-full flex-col gap-1 rounded-t-2xl bg-[var(--surface)] pt-2 pb-[max(16px,env(safe-area-inset-bottom))]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2">
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            Tip menu
          </h2>
          <button
            type="button"
            aria-label="Close tip menu"
            onClick={onClose}
            className="text-lg text-[var(--foreground)]"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-1.5">
          <span className="text-sm font-medium text-[var(--foreground)]">
            🪙 {balance} coins
          </span>
          <button
            type="button"
            onClick={onGetCoins}
            className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)]"
          >
            + Get coins
          </button>
        </div>

        {coinsToTopFan > 0 ? (
          <p className="px-4 pb-1 text-xs text-[var(--muted)]">
            👑 Tip {coinsToTopFan} more coins to become Top fan
          </p>
        ) : null}

        <ul className="flex max-h-80 flex-col overflow-y-auto px-2">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onPick(item)}
                aria-label={`${item.label}, ${item.priceCents} coins${item.explicit ? ", 18 plus" : ""}`}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[var(--foreground)]"
              >
                <span className="text-xl">{item.emoji}</span>
                <span className="flex-1 text-sm">
                  {item.label}
                  {item.explicit ? (
                    <span className="ml-2 rounded bg-[var(--danger)]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--danger)]">
                      18+
                    </span>
                  ) : null}
                </span>
                <span className="text-sm font-semibold text-[var(--accent)]">
                  +{item.priceCents}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
