import { beforeEach, describe, expect, it } from "vitest";
import {
  addCoins,
  coinsToBecomeTopFan,
  createWalletState,
  recordTip,
  spendCoins,
  YOU_HANDLE,
} from "./coins";

// No jsdom in this project's vitest config, so localStorage isn't a real global here; a tiny
// in-memory stand-in exercises the same read/write path coins.ts uses in the browser.
class FakeStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("coins wallet", () => {
  beforeEach(() => {
    globalThis.localStorage = new FakeStorage();
  });

  it("starts at zero balance with no top fan", () => {
    const state = createWalletState();
    expect(state.balance).toBe(0);
    expect(state.topFan).toBeNull();
    expect(state.goal.current).toBe(0);
  });

  it("recordTip feeds the goal and crowns the biggest tipper", () => {
    let state = createWalletState();
    state = recordTip(state, "steve_k", 255);
    state = recordTip(state, "nightowl_92", 100);
    expect(state.goal.current).toBe(355);
    expect(state.topFan).toEqual({ handle: "steve_k", coins: 255 });
  });

  it("spendCoins deducts balance and counts as a tip under YOU_HANDLE", () => {
    let state = createWalletState();
    state = addCoins(state, 500);
    state = spendCoins(state, 120);
    expect(state.balance).toBe(380);
    expect(state.spent).toBe(120);
    expect(state.tipsByHandle[YOU_HANDLE]).toBe(120);
    expect(state.topFan).toEqual({ handle: YOU_HANDLE, coins: 120 });
  });

  it("spendCoins is a no-op when the balance is insufficient", () => {
    let state = createWalletState();
    state = addCoins(state, 50);
    const before = state;
    state = spendCoins(state, 100);
    expect(state).toBe(before);
  });

  it("ignores non-positive amounts", () => {
    let state = createWalletState();
    const before = state;
    state = recordTip(state, "steve_k", 0);
    state = spendCoins(state, -10);
    state = addCoins(state, 0);
    expect(state).toBe(before);
  });

  it("coinsToBecomeTopFan reports the gap to overtake, and zero once ahead", () => {
    let state = createWalletState();
    state = addCoins(state, 1000);
    state = recordTip(state, "steve_k", 255);
    expect(coinsToBecomeTopFan(state)).toBe(256);
    state = spendCoins(state, 256);
    expect(coinsToBecomeTopFan(state)).toBe(0);
  });

  it("persists balance across wallet instances via localStorage", () => {
    addCoins(createWalletState(), 300);
    const reloaded = createWalletState();
    expect(reloaded.balance).toBe(300);
  });
});
