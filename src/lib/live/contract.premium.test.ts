import { describe, expect, it } from "vitest";
import {
  clipPremiumReportSchema,
  clipResultSchema,
  isSwapSession,
  LIVE_TUNABLES,
  renderBackendSchema,
} from "./contract";

describe("contract: Premium (wan14b)", () => {
  it("accepts wan14b as a render backend", () => {
    expect(renderBackendSchema.parse("wan14b")).toBe("wan14b");
    expect(renderBackendSchema.safeParse("wan15b").success).toBe(false);
  });

  it("treats Premium as a swap session on the client, and nothing else", () => {
    expect(isSwapSession("swap")).toBe(true);
    expect(isSwapSession("wan14b")).toBe(true);
    expect(isSwapSession("turbo")).toBe(false);
    expect(isSwapSession("reference")).toBe(false);
    expect(isSwapSession(undefined)).toBe(false);
  });

  it("allows a 5 s clip result and carries the premium report", () => {
    const shape = clipResultSchema.shape;
    expect(
      shape.durationSec.safeParse(LIVE_TUNABLES.WAN14B_CLIP_SEC).success,
    ).toBe(true);
    expect(shape.durationSec.safeParse(4).success).toBe(false);
    expect(
      clipPremiumReportSchema.safeParse({
        status: "fallback",
        wanMs: 40_000,
        reason: "timeout: The operation timed out.",
      }).success,
    ).toBe(true);
    expect(shape.premium.safeParse(undefined).success).toBe(true);
  });

  it("prices a clip from the H100 rate and keeps 81 frames at about 5 s", () => {
    expect(LIVE_TUNABLES.WAN14B_COST_PER_SEC_USD * 3600).toBeCloseTo(3.95);
    expect(LIVE_TUNABLES.WAN14B_NUM_FRAMES % 4).toBe(1);
    expect(Math.round(LIVE_TUNABLES.WAN14B_NUM_FRAMES / 16)).toBe(
      LIVE_TUNABLES.WAN14B_CLIP_SEC,
    );
  });
});
