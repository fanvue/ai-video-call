"use client";

import type { LiveSessionStatus } from "@/lib/live/client/useLiveSession";
import type { TopFan } from "@/lib/live/client/coins";
import { RollingNumber } from "@/components/live/RollingNumber";
import { StatusPill } from "@/components/live/StatusPill";

type TopBarProps = {
  displayName: string;
  status: LiveSessionStatus;
  elapsed: string;
  viewerCount: number;
  privateMode: boolean;
  goal: { current: number; target: number };
  coinBalance: number;
  topFan: TopFan | null;
  nowPlayingLabel: string | null;
  onTipClick: () => void;
  onGetCoinsClick: () => void;
};

export const TopBar = ({
  displayName,
  status,
  elapsed,
  viewerCount,
  privateMode,
  goal,
  coinBalance,
  topFan,
  nowPlayingLabel,
  onTipClick,
  onGetCoinsClick,
}: TopBarProps) => {
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  const goalPct = Math.min(
    100,
    Math.round((goal.current / Math.max(1, goal.target)) * 100),
  );

  return (
    <div className="flex items-start justify-between gap-2 p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-sm font-bold text-[var(--accent-contrast)]">
            {initial}
          </span>
          <span className="truncate text-sm font-semibold text-white">
            {displayName}
          </span>
          <StatusPill status={status} />
          <span className="text-xs text-white/70">{elapsed}</span>
        </div>

        {privateMode ? (
          <p className="text-xs font-medium text-white/80">Private with you</p>
        ) : (
          <p className="flex items-center gap-1 text-xs text-white/70">
            <RollingNumber
              value={viewerCount}
              ariaLabel={`${viewerCount} viewers`}
            />
            <span>{viewerCount === 1 ? "viewer" : "viewers"}</span>
          </p>
        )}

        {!privateMode ? (
          <div className="flex w-40 flex-col gap-0.5">
            <p className="text-[11px] font-medium text-white/80">
              💛 Tip goal {goal.current} / {goal.target}
            </p>
            <div
              role="progressbar"
              aria-label="Tip goal progress"
              aria-valuenow={goal.current}
              aria-valuemin={0}
              aria-valuemax={goal.target}
              className="h-1.5 w-full overflow-hidden rounded-full bg-white/20"
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#ffd21a] to-[var(--accent)] transition-[width] duration-500"
                style={{ width: `${goalPct}%` }}
              />
            </div>
          </div>
        ) : null}

        {nowPlayingLabel ? (
          <p className="truncate text-[11px] text-white/60">
            {nowPlayingLabel}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label={`Coin balance ${coinBalance}. Get more coins`}
            onClick={onGetCoinsClick}
            className="rounded-full border border-white/25 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-md"
          >
            🪙 {coinBalance} +
          </button>
          <button
            type="button"
            aria-label="Open tip menu"
            onClick={onTipClick}
            className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-b from-[#ffd21a] to-[var(--accent)] text-xs font-bold text-[var(--accent-contrast)] shadow-[0_4px_14px_rgba(255,171,0,0.4)]"
          >
            Tip
          </button>
        </div>
        {topFan ? (
          <span className="whitespace-nowrap rounded-full border border-[var(--accent)]/40 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-md">
            👑 {topFan.handle} {topFan.coins}
          </span>
        ) : null}
      </div>
    </div>
  );
};
