"use client";

import type { TipMenuItem } from "@/lib/live/contract";

type TipMenuDrawerProps = {
  open: boolean;
  items: TipMenuItem[];
  onClose: () => void;
  onPick: (item: TipMenuItem) => void;
};

const formatPrice = (priceCents: number): string =>
  priceCents === 0 ? "Free" : `$${(priceCents / 100).toFixed(2)}`;

// Sending an item only tags the fan's message as `paid: true` in the transcript for display;
// real payment execution lives in Fanvue's payment stack, behind human approval, not here.
export const TipMenuDrawer = ({
  open,
  items,
  onClose,
  onPick,
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
        <ul className="flex max-h-80 flex-col overflow-y-auto px-2">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onPick(item)}
                className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left text-[var(--foreground)]"
              >
                <span className="text-sm">{item.label}</span>
                <span className="text-sm font-semibold text-[var(--accent)]">
                  {formatPrice(item.priceCents)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
