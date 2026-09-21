import { describe, expect, it } from "vitest";
import type { Body, Wardrobe } from "../contract";
import { reconcilePose, reconcileWardrobe } from "./reconcileState";

const wardrobe = (overrides: Partial<Wardrobe> = {}): Wardrobe => ({
  top: { on: true, description: "top" },
  bottom: { on: true, description: "bottom" },
  bra: { on: true, description: "bra" },
  panties: { on: true, description: "panties" },
  removedOrder: [],
  ...overrides,
});

const body = (overrides: Partial<Body> = {}): Body => ({
  pose: "sitting",
  facing: "camera",
  hands: "free",
  contact: "none",
  prop: "none",
  framing: "wider",
  ...overrides,
});

describe("reconcileWardrobe", () => {
  it("leaves wardrobe unchanged when observed matches expected", () => {
    const result = reconcileWardrobe(
      wardrobe(),
      { top: true, bottom: true, bra: true, panties: true },
      "bra",
    );
    expect(result).toEqual(wardrobe());
  });

  it("flips the target garment off and appends it to removedOrder when observed shows it off", () => {
    const result = reconcileWardrobe(wardrobe(), { bra: false }, "bra");
    expect(result.bra.on).toBe(false);
    expect(result.removedOrder).toEqual(["bra"]);
  });

  it("flips the target garment on and removes it from removedOrder when observed shows it on", () => {
    const expected = wardrobe({
      top: { on: false, description: "top" },
      removedOrder: ["top"],
    });
    const result = reconcileWardrobe(expected, { top: true }, "top");
    expect(result.top.on).toBe(true);
    expect(result.removedOrder).toEqual([]);
  });

  it("does not duplicate an already-recorded removal", () => {
    const expected = wardrobe({
      bra: { on: false, description: "bra" },
      removedOrder: ["bra"],
    });
    const result = reconcileWardrobe(expected, { bra: false }, "bra");
    expect(result.removedOrder).toEqual(["bra"]);
  });

  it("ignores the target garment when the observation is silent on it", () => {
    const result = reconcileWardrobe(wardrobe(), {}, "bra");
    expect(result).toEqual(wardrobe());
  });

  it("preserves the target garment's description while flipping its on/off state", () => {
    const result = reconcileWardrobe(wardrobe(), { panties: false }, "panties");
    expect(result.panties).toEqual({ on: false, description: "panties" });
  });

  it("ignores drift on a non-target garment, even when observed", () => {
    const result = reconcileWardrobe(wardrobe(), { bra: false }, "panties");
    expect(result.bra.on).toBe(true);
    expect(result.removedOrder).toEqual([]);
  });

  it("does nothing when no target garment is given", () => {
    const result = reconcileWardrobe(wardrobe(), { bra: false, top: false });
    expect(result).toEqual(wardrobe());
  });

  it("the target garment observed still on (unmet removal) is always reconciled (retry path)", () => {
    const result = reconcileWardrobe(wardrobe(), { bra: true }, "bra");
    expect(result.bra.on).toBe(true);
  });
});

describe("reconcilePose", () => {
  it("adopts the observed pose when it differs from expected", () => {
    const result = reconcilePose(body({ pose: "sitting" }), "standing");
    expect(result.pose).toBe("standing");
  });

  it("leaves the body unchanged when no pose was observed", () => {
    const expected = body({ pose: "sitting" });
    const result = reconcilePose(expected, undefined);
    expect(result).toEqual(expected);
  });
});
