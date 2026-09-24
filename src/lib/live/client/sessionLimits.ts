import { LIVE_TUNABLES } from "@/lib/live/contract";

// Fails closed: an empty, non-numeric or missing value takes the default, never "no limit".
const clampOrDefault = (
  value: string | number | undefined,
  fallback: number,
  max: number,
  round: (n: number) => number,
): number => {
  if (value === undefined || (typeof value === "string" && !value.trim())) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, round(parsed)));
};

export const sessionMinutesFrom = (value?: string | number): number =>
  clampOrDefault(
    value,
    LIVE_TUNABLES.DEFAULT_SESSION_MINUTES,
    LIVE_TUNABLES.MAX_SESSION_MINUTES,
    Math.round,
  );

export const sessionCostCapFrom = (value?: string | number): number =>
  clampOrDefault(
    value,
    LIVE_TUNABLES.DEFAULT_SESSION_COST_CAP_USD,
    LIVE_TUNABLES.MAX_SESSION_COST_CAP_USD,
    (n) => n,
  );
