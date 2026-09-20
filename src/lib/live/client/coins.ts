// Local demo coin wallet: no real payment, balance persists to localStorage only.

export type CoinPack = {
  id: string;
  coins: number;
  priceCents: number;
};

// Flavour packs for the "Get coins" sheet. Demo pricing only; no payment provider is called.
export const COIN_PACKS: readonly CoinPack[] = [
  { id: "pack-100", coins: 100, priceCents: 499 },
  { id: "pack-550", coins: 550, priceCents: 1999 },
  { id: "pack-1200", coins: 1200, priceCents: 3999 },
];

// The fan's own tips are tracked under this key alongside room-sim viewer handles, so one
// tipsByHandle map can produce both "who's top fan" and "is that top fan me".
export const YOU_HANDLE = "you";

const STORAGE_KEY = "live-coins-balance-v1";
const DEFAULT_STARTING_BALANCE = 0;
const DEFAULT_GOAL_TARGET = 500;

export type TopFan = { handle: string; coins: number };

export type CoinWalletState = {
  balance: number;
  spent: number;
  tipsByHandle: Record<string, number>;
  goal: { current: number; target: number };
  topFan: TopFan | null;
};

const getStorage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const readPersistedBalance = (): number | null => {
  try {
    const raw = getStorage()?.getItem(STORAGE_KEY) ?? null;
    if (raw === null) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    // Private browsing / blocked storage: fall back to the in-memory default.
    return null;
  }
};

const persistBalance = (balance: number): void => {
  try {
    getStorage()?.setItem(STORAGE_KEY, String(balance));
  } catch {
    // Ignore: the wallet still works for the rest of the session, it just won't survive a reload.
  }
};

export const createWalletState = (
  goalTarget: number = DEFAULT_GOAL_TARGET,
): CoinWalletState => ({
  balance: readPersistedBalance() ?? DEFAULT_STARTING_BALANCE,
  spent: 0,
  tipsByHandle: {},
  goal: { current: 0, target: goalTarget },
  topFan: null,
});

const topFanOf = (tipsByHandle: Record<string, number>): TopFan | null => {
  let top: TopFan | null = null;
  for (const [handle, coins] of Object.entries(tipsByHandle)) {
    if (!top || coins > top.coins) {
      top = { handle, coins };
    }
  }
  return top;
};

// Records a tip from any source (a room-sim viewer, or the fan under YOU_HANDLE) into the shared
// goal and crown. Does not touch balance; callers that spend the fan's own coins call spendCoins.
export const recordTip = (
  state: CoinWalletState,
  handle: string,
  coins: number,
): CoinWalletState => {
  if (coins <= 0) {
    return state;
  }
  const tipsByHandle = {
    ...state.tipsByHandle,
    [handle]: (state.tipsByHandle[handle] ?? 0) + coins,
  };
  return {
    ...state,
    tipsByHandle,
    goal: { ...state.goal, current: state.goal.current + coins },
    topFan: topFanOf(tipsByHandle),
  };
};

// The fan spending coins on a tip or a menu action: deducts balance, tracks total spend, and
// feeds the same goal/crown as a room-sim viewer's tip would.
export const spendCoins = (
  state: CoinWalletState,
  coins: number,
): CoinWalletState => {
  if (coins <= 0 || coins > state.balance) {
    return state;
  }
  const tipped = recordTip(state, YOU_HANDLE, coins);
  const next: CoinWalletState = {
    ...tipped,
    balance: tipped.balance - coins,
    spent: tipped.spent + coins,
  };
  persistBalance(next.balance);
  return next;
};

// Demo top-up: the "Get coins" sheet's Buy button calls this instead of any payment integration.
export const addCoins = (
  state: CoinWalletState,
  coins: number,
): CoinWalletState => {
  if (coins <= 0) {
    return state;
  }
  const next: CoinWalletState = { ...state, balance: state.balance + coins };
  persistBalance(next.balance);
  return next;
};

// How many more coins the fan would need to tip to overtake the current top fan. Zero once the
// fan already holds the crown or nobody has tipped yet.
export const coinsToBecomeTopFan = (state: CoinWalletState): number => {
  const top = state.topFan;
  if (!top || top.handle === YOU_HANDLE) {
    return 0;
  }
  const yours = state.tipsByHandle[YOU_HANDLE] ?? 0;
  return Math.max(0, top.coins - yours + 1);
};
