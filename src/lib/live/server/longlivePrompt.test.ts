import { describe, expect, it } from "vitest";
import type { CreatorProfile, LiveState, Wardrobe } from "../contract";
import { planLongLiveGreeting, planLongLiveRequest } from "./longlivePrompt";

const wardrobe = (overrides: Partial<Wardrobe> = {}): Wardrobe => ({
  top: { on: true, description: "black ribbed tank top" },
  bottom: { on: true, description: "denim shorts" },
  bra: { on: true, description: "black lace bra" },
  panties: { on: true, description: "black lace panties" },
  removedOrder: [],
  ...overrides,
});

const state = (overrides: Partial<LiveState> = {}): LiveState => {
  const body = {
    pose: "sitting",
    facing: "camera",
    hands: "free",
    contact: "none",
    prop: "none",
    framing: "medium",
  } as const;
  return {
    wardrobe: wardrobe(),
    body,
    baselineBody: body,
    world: "Settling in, webcam just turned on.",
    surroundings: "A tidy bedroom with a lamp and a made bed.",
    ...overrides,
  };
};

const creator: CreatorProfile = {
  id: "creator-1",
  displayName: "Mia",
  lookLock: "Long wavy auburn hair, freckles, green eyes, slim build.",
  sceneId: "bedroom",
  tipMenu: [],
};

const UNDRESS_WORDS =
  /\b(take[sn]? off|takes off|remov\w*|undress\w*|strip\w*)\b/i;

describe("planLongLiveGreeting", () => {
  it("restates the adult woman, her look, wardrobe, room and the fixed webcam", () => {
    const { prompt, settlePrompt, nextState } = planLongLiveGreeting(
      creator,
      state(),
    );
    expect(prompt).toContain("One adult woman");
    expect(prompt).toContain(creator.lookLock);
    expect(prompt).toContain("black lace bra");
    expect(prompt).toContain("WARDROBE LOCK");
    expect(prompt).toContain("FIXED WEBCAM");
    expect(prompt).toContain("A tidy bedroom");
    expect(prompt).toContain("waves hello");
    expect(settlePrompt).toContain("One adult woman");
    expect(nextState).toEqual(state());
  });

  it("never names undressing and never uses an em dash", () => {
    const { prompt, settlePrompt } = planLongLiveGreeting(creator, state());
    for (const text of [prompt, settlePrompt]) {
      expect(text).not.toMatch(UNDRESS_WORDS);
      expect(text).not.toContain("\u2014");
    }
  });
});

describe("planLongLiveRequest", () => {
  it("quotes a non-wardrobe action without naming any garment removal", () => {
    const { prompt, nextState } = planLongLiveRequest(
      creator,
      state(),
      "wave at me",
    );
    expect(prompt).toContain('a viewer just asked: "wave at me"');
    expect(prompt).toContain("WARDROBE LOCK");
    expect(prompt).not.toMatch(UNDRESS_WORDS);
    expect(nextState.wardrobe).toEqual(wardrobe());
  });

  it("names the removal only for a wardrobe request, and advances the wardrobe", () => {
    const { prompt, settlePrompt, nextState } = planLongLiveRequest(
      creator,
      state(),
      "take your bra off",
    );
    expect(prompt).toContain("she takes off her black lace bra");
    expect(prompt).not.toContain("WARDROBE LOCK");
    expect(nextState.wardrobe.bra.on).toBe(false);
    // The settle scene describes the new state positively and does not replay the removal.
    expect(settlePrompt).not.toMatch(UNDRESS_WORDS);
    expect(settlePrompt).not.toContain("(black lace bra)");
    expect(settlePrompt).toContain("WARDROBE LOCK");
  });

  it("does not quote a negated wardrobe request, since the words themselves cue the model", () => {
    const { prompt, nextState } = planLongLiveRequest(
      creator,
      state(),
      "don't take your top off",
    );
    expect(prompt).not.toContain("don't take your top off");
    expect(prompt).not.toMatch(UNDRESS_WORDS);
    expect(nextState.wardrobe.top.on).toBe(true);
  });

  it("does not replay a removal for a garment that is already off", () => {
    const current = state({
      wardrobe: wardrobe({
        bra: { on: false, description: "black lace bra" },
        removedOrder: ["bra"],
      }),
    });
    const { prompt } = planLongLiveRequest(
      creator,
      current,
      "take your bra off",
    );
    expect(prompt).not.toMatch(UNDRESS_WORDS);
  });

  it("puts a garment back on and restores it in the next state", () => {
    const current = state({
      wardrobe: wardrobe({
        top: { on: false, description: "black ribbed tank top" },
        removedOrder: ["top"],
      }),
    });
    const { prompt, nextState } = planLongLiveRequest(
      creator,
      current,
      "put your top back on",
    );
    expect(prompt).toContain("she puts her black ribbed tank top back on");
    expect(nextState.wardrobe.top.on).toBe(true);
  });

  it("stays within 2000 chars and trims the room, not the action", () => {
    const current = state({ surroundings: "A very long room. ".repeat(80) });
    const { prompt } = planLongLiveRequest(creator, current, "wave at me");
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(prompt).toContain('a viewer just asked: "wave at me"');
    expect(prompt).toContain("FIXED WEBCAM");
  });
});
