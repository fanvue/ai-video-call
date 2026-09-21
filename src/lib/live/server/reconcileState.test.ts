import { describe, expect, it } from "vitest";
import type { Wardrobe } from "../contract";
import { reconcileWardrobe } from "./reconcileState";

const wardrobe = (overrides: Partial<Wardrobe> = {}): Wardrobe => ({
  top: { on: true, description: "top" },
  bottom: { on: true, description: "bottom" },
  bra: { on: true, description: "bra" },
  panties: { on: true, description: "panties" },
  removedOrder: [],
  ...overrides,
});

describe("reconcileWardrobe", () => {
  it("leaves wardrobe unchanged when observed matches expected", () => {
    const result = reconcileWardrobe(wardrobe(), {
      top: true,
      bottom: true,
      bra: true,
      panties: true,
    });
    expect(result).toEqual(wardrobe());
  });

  it("flips a garment off and appends it to removedOrder when observed shows it off", () => {
    const result = reconcileWardrobe(wardrobe(), { bra: false });
    expect(result.bra.on).toBe(false);
    expect(result.removedOrder).toEqual(["bra"]);
  });

  it("flips a garment on and removes it from removedOrder when observed shows it on", () => {
    const expected = wardrobe({
      top: { on: false, description: "top" },
      removedOrder: ["top"],
    });
    const result = reconcileWardrobe(expected, { top: true });
    expect(result.top.on).toBe(true);
    expect(result.removedOrder).toEqual([]);
  });

  it("does not duplicate an already-recorded removal", () => {
    const expected = wardrobe({
      bra: { on: false, description: "bra" },
      removedOrder: ["bra"],
    });
    const result = reconcileWardrobe(expected, { bra: false });
    expect(result.removedOrder).toEqual(["bra"]);
  });

  it("ignores garments the observation is silent on", () => {
    const result = reconcileWardrobe(wardrobe(), {});
    expect(result).toEqual(wardrobe());
  });

  it("preserves each garment's description while flipping its on/off state", () => {
    const result = reconcileWardrobe(wardrobe(), { panties: false });
    expect(result.panties).toEqual({ on: false, description: "panties" });
  });
});
