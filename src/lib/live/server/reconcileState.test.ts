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
      "remove",
      "bra",
    );
    expect(result).toEqual(wardrobe());
  });

  it("flips a garment off and appends it to removedOrder when observed shows it off and matches the request's direction", () => {
    const result = reconcileWardrobe(wardrobe(), { bra: false }, "remove");
    expect(result.bra.on).toBe(false);
    expect(result.removedOrder).toEqual(["bra"]);
  });

  it("flips a garment on and removes it from removedOrder when observed shows it on and matches the request's direction", () => {
    const expected = wardrobe({
      top: { on: false, description: "top" },
      removedOrder: ["top"],
    });
    const result = reconcileWardrobe(expected, { top: true }, "add");
    expect(result.top.on).toBe(true);
    expect(result.removedOrder).toEqual([]);
  });

  it("does not duplicate an already-recorded removal", () => {
    const expected = wardrobe({
      bra: { on: false, description: "bra" },
      removedOrder: ["bra"],
    });
    const result = reconcileWardrobe(expected, { bra: false }, "remove");
    expect(result.removedOrder).toEqual(["bra"]);
  });

  it("ignores garments the observation is silent on", () => {
    const result = reconcileWardrobe(wardrobe(), {}, "remove");
    expect(result).toEqual(wardrobe());
  });

  it("preserves each garment's description while flipping its on/off state", () => {
    const result = reconcileWardrobe(wardrobe(), { panties: false }, "remove");
    expect(result.panties).toEqual({ on: false, description: "panties" });
  });

  it("direction null ignores unrequested drift: an observed-off garment stays on", () => {
    const result = reconcileWardrobe(wardrobe(), { bra: false }, null);
    expect(result.bra.on).toBe(true);
    expect(result.removedOrder).toEqual([]);
  });

  it("direction remove + the beat's own target garment observed still on is always reconciled (retry path)", () => {
    const result = reconcileWardrobe(
      wardrobe(),
      { bra: true },
      "remove",
      "bra",
    );
    expect(result.bra.on).toBe(true);
  });

  it("direction remove adopts an untargeted garment's observed-off drift", () => {
    const result = reconcileWardrobe(
      wardrobe(),
      { panties: false },
      "remove",
      "bra",
    );
    expect(result.panties.on).toBe(false);
  });

  it("direction add ignores an untargeted garment's observed-off drift", () => {
    const result = reconcileWardrobe(wardrobe(), { top: false }, "add", "bra");
    expect(result.top.on).toBe(true);
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
