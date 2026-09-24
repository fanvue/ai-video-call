import { describe, expect, it } from "vitest";
import { LIVE_TUNABLES } from "@/lib/live/contract";
import { sessionCostCapFrom, sessionMinutesFrom } from "./sessionLimits";

describe("session limits", () => {
  it("defaults to 15 minutes and a $40 cap", () => {
    expect(LIVE_TUNABLES.DEFAULT_SESSION_MINUTES).toBe(15);
    expect(LIVE_TUNABLES.DEFAULT_SESSION_COST_CAP_USD).toBe(40);
    expect(sessionMinutesFrom()).toBe(15);
    expect(sessionCostCapFrom()).toBe(40);
  });

  it.each([
    ["", 15],
    ["   ", 15],
    ["abc", 15],
    ["Infinity", 15],
    ["0", 1],
    ["-4", 1],
    ["12", 12],
    [" 20 ", 20],
    ["7.6", 8],
    ["31", 30],
    ["500", 30],
    [Number.NaN, 15],
  ])("minutes %j becomes %d", (input, expected) => {
    expect(sessionMinutesFrom(input)).toBe(expected);
  });

  it.each([
    ["", 40],
    ["abc", 40],
    ["-Infinity", 40],
    ["0", 1],
    ["0.5", 1],
    ["25.5", 25.5],
    ["100", 100],
    ["250", 100],
    [Number.NaN, 40],
  ])("spend cap %j becomes %d", (input, expected) => {
    expect(sessionCostCapFrom(input)).toBe(expected);
  });
});
