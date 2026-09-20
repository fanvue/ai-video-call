"use client";

import { useEffect, useRef, useState } from "react";
import type { CoinPack } from "@/lib/live/client/coins";

type GetCoinsSheetProps = {
  open: boolean;
  balance: number;
  packs: readonly CoinPack[];
  onClose: () => void;
  onBuy: (pack: CoinPack) => void;
};

const formatPrice = (priceCents: number): string =>
  `$${(priceCents / 100).toFixed(2)}`;

// Demo only: the Buy button adds coins straight to the local wallet. No card is charged, no
// payment provider is called; the padlock line below just mirrors the reference show's copy.
export const GetCoinsSheet = ({
  open,
  balance,
  packs,
  onClose,
  onBuy,
}: GetCoinsSheetProps) => {
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    },
    [],
  );

  if (!open) {
    return null;
  }

  const handleBuy = (pack: CoinPack) => {
    onBuy(pack);
    setToastVisible(true);
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = setTimeout(() => setToastVisible(false), 2500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex w-full flex-col gap-3 rounded-t-2xl bg-[var(--surface)] pt-2 pb-[max(16px,env(safe-area-inset-bottom))]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2">
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            Get coins
          </h2>
          <button
            type="button"
            aria-label="Close get coins"
            onClick={onClose}
            className="text-lg text-[var(--foreground)]"
          >
            ✕
          </button>
        </div>

        <p className="px-4 text-sm font-medium text-[var(--foreground)]">
          🪙 {balance} coins
        </p>

        <ul className="flex flex-col gap-2 px-4">
          {packs.map((pack) => (
            <li key={pack.id}>
              <button
                type="button"
                onClick={() => handleBuy(pack)}
                aria-label={`Buy ${pack.coins} coins for ${formatPrice(pack.priceCents)}`}
                className="flex w-full items-center justify-between rounded-xl border border-[var(--border)] px-4 py-3 text-left text-[var(--foreground)]"
              >
                <span className="text-sm font-medium">
                  🪙 {pack.coins} coins
                </span>
                <span className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)]">
                  Buy · {formatPrice(pack.priceCents)}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="px-4 text-[11px] text-[var(--muted)]">
          🔒 Pay with your saved Fanvue card · secure checkout
        </p>
        <p className="px-4 pb-1 text-[11px] text-[var(--muted)]">
          Demo only: no card is charged, this adds coins to your local balance.
        </p>

        {toastVisible ? (
          <p
            role="status"
            className="mx-4 mb-1 rounded-full bg-[var(--accent)] px-3 py-2 text-center text-xs font-semibold text-[var(--accent-contrast)]"
          >
            Demo balance topped up
          </p>
        ) : null}
      </div>
    </div>
  );
};
