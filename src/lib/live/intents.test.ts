import { describe, expect, it } from "vitest";
import type { Body, LiveState, Wardrobe } from "./contract";
import { HELD_OBJECTS, isIntentSatisfied } from "./intents";

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

const state = (
  overrides: Partial<
    Pick<LiveState, "wardrobe" | "body" | "baselineBody">
  > = {},
): Pick<LiveState, "wardrobe" | "body" | "baselineBody"> => ({
  wardrobe: wardrobe(),
  body: body(),
  baselineBody: body(),
  ...overrides,
});

describe("HELD_OBJECTS", () => {
  it("contains exactly the fetchable, hand-occupying props", () => {
    expect(HELD_OBJECTS.has("vibrator")).toBe(true);
    expect(HELD_OBJECTS.has("dildo")).toBe(true);
    expect(HELD_OBJECTS.has("drink")).toBe(true);
    expect(HELD_OBJECTS.has("phone")).toBe(false);
    expect(HELD_OBJECTS.has("none")).toBe(false);
  });
});

describe("isIntentSatisfied", () => {
  it("removeGarment is satisfied only once the garment is off", () => {
    expect(
      isIntentSatisfied({ type: "removeGarment", garment: "bra" }, state()),
    ).toBe(false);
    expect(
      isIntentSatisfied(
        { type: "removeGarment", garment: "bra" },
        state({
          wardrobe: wardrobe({ bra: { on: false, description: "bra" } }),
        }),
      ),
    ).toBe(true);
  });

  it("addGarment is satisfied only once the garment is on", () => {
    expect(
      isIntentSatisfied(
        { type: "addGarment", garment: "top" },
        state({
          wardrobe: wardrobe({ top: { on: false, description: "top" } }),
        }),
      ),
    ).toBe(false);
    expect(
      isIntentSatisfied({ type: "addGarment", garment: "top" }, state()),
    ).toBe(true);
  });

  it("pose requires both pose and facing to match", () => {
    const s = state({ body: body({ pose: "standing", facing: "camera" }) });
    expect(
      isIntentSatisfied(
        { type: "pose", pose: "standing", facing: "camera" },
        s,
      ),
    ).toBe(true);
    expect(
      isIntentSatisfied({ type: "pose", pose: "standing", facing: "away" }, s),
    ).toBe(false);
  });

  it("framing and fetchProp are satisfied by exact match", () => {
    const s = state({ body: body({ framing: "torso", prop: "dildo" }) });
    expect(isIntentSatisfied({ type: "framing", framing: "torso" }, s)).toBe(
      true,
    );
    expect(isIntentSatisfied({ type: "framing", framing: "wider" }, s)).toBe(
      false,
    );
    expect(isIntentSatisfied({ type: "fetchProp", prop: "dildo" }, s)).toBe(
      true,
    );
    expect(isIntentSatisfied({ type: "fetchProp", prop: "vibrator" }, s)).toBe(
      false,
    );
  });

  it("rest requires empty prop, no contact, and free or typing hands", () => {
    expect(isIntentSatisfied({ type: "rest" }, state())).toBe(true);
    expect(
      isIntentSatisfied(
        { type: "rest" },
        state({ body: body({ hands: "typing" }) }),
      ),
    ).toBe(true);
    expect(
      isIntentSatisfied(
        { type: "rest" },
        state({ body: body({ prop: "vibrator", hands: "holdingProp" }) }),
      ),
    ).toBe(false);
    expect(
      isIntentSatisfied(
        { type: "rest" },
        state({ body: body({ contact: "self", hands: "onBody" }) }),
      ),
    ).toBe(false);
  });

  it("rest is not satisfied by free hands alone when pose has drifted from baseline", () => {
    // Free hands but still kneeling from an earlier act, with the baseline pose being "sitting".
    expect(
      isIntentSatisfied(
        { type: "rest" },
        state({ body: body({ pose: "kneeling" }) }),
      ),
    ).toBe(false);
    expect(
      isIntentSatisfied(
        { type: "rest" },
        state({ body: body({ facing: "away" }) }),
      ),
    ).toBe(false);
    expect(
      isIntentSatisfied(
        { type: "rest" },
        state({ body: body({ framing: "torso" }) }),
      ),
    ).toBe(false);
    // Satisfied once body pose/facing/framing matches a non-default baseline too.
    expect(
      isIntentSatisfied(
        { type: "rest" },
        state({
          body: body({ pose: "kneeling", facing: "away", framing: "torso" }),
          baselineBody: body({
            pose: "kneeling",
            facing: "away",
            framing: "torso",
          }),
        }),
      ),
    ).toBe(true);
  });

  it("action-only intents are never already satisfied", () => {
    const s = state();
    expect(isIntentSatisfied({ type: "touch" }, s)).toBe(false);
    expect(isIntentSatisfied({ type: "useProp", mode: "mouth" }, s)).toBe(
      false,
    );
    expect(isIntentSatisfied({ type: "act", act: "gesture" }, s)).toBe(false);
    expect(isIntentSatisfied({ type: "hold", line: "hi" }, s)).toBe(false);
    expect(isIntentSatisfied({ type: "verbatim", text: "do a spin" }, s)).toBe(
      false,
    );
  });
});
