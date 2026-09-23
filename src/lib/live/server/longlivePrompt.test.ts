import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorProfile, LiveState, Wardrobe } from "../contract";

const create = vi.fn();
vi.mock("@/lib/groq", () => ({
  GROQ_TEXT_MODEL: "test-model",
  createGroqChatCompletion: (...args: unknown[]) => create(...args),
}));

const {
  needsClipHandoff,
  planLongLiveCheckIn,
  planLongLiveGreeting,
  planLongLiveRequest,
  planLongLiveSettle,
} = await import("./longlivePrompt");

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
  /\b(take[sn]? off|takes off|pulls? her .* off|unhooks?|slides? (her|them|it) down|remov\w*|undress\w*|strip\w*)\b/i;
// What the old builder leaked into prompts: labels, negations, meta words the video model renders.
const CAPS_LABEL = /\b[A-Z]{3,}\b/;
const NEGATION = /\b(not|no|never|without)\b|n't\b/i;
const META = /\b(zoom|pan|text|subtitles?|watermark|UI|webcam|livestream)\b/i;

const wordCount = (text: string): number => text.split(/\s+/).length;

const expectCaption = (text: string): void => {
  expect(text).toMatch(/^An adult woman/);
  expect(text).not.toMatch(CAPS_LABEL);
  expect(text).not.toMatch(NEGATION);
  expect(text).not.toMatch(META);
  expect(text).not.toContain(String.fromCharCode(0x2014));
  expect(wordCount(text)).toBeGreaterThanOrEqual(30);
  expect(wordCount(text)).toBeLessThanOrEqual(110);
};

beforeEach(() => {
  create.mockReset();
  create.mockRejectedValue(new Error("groq down"));
});

describe("planLongLiveGreeting", () => {
  it("is a short positive caption: her look, what she wears, one action, the room", () => {
    const { prompt, settlePrompt, nextState } = planLongLiveGreeting(
      creator,
      state(),
    );
    expectCaption(prompt);
    expectCaption(settlePrompt);
    expect(prompt).toContain("An adult woman with long wavy auburn hair");
    expect(prompt).toContain("wearing her black ribbed tank top");
    expect(prompt).toContain("waves hello");
    expect(prompt).toContain("A tidy bedroom");
    expect(prompt).toContain("Static shot at eye level");
    expect(nextState).toEqual(state());
  });

  it("never names undressing, and the settle scene never names her clothes", () => {
    const { prompt, settlePrompt } = planLongLiveGreeting(creator, state());
    expect(prompt).not.toMatch(UNDRESS_WORDS);
    expect(settlePrompt).not.toMatch(UNDRESS_WORDS);
    expect(settlePrompt).not.toContain("black lace bra");
  });

  it("drops a look that frames her as young and keeps only the adult subject", () => {
    const { prompt } = planLongLiveGreeting(
      { ...creator, lookLock: "Young girl with pigtails." },
      state(),
    );
    expect(prompt).toMatch(/^An adult woman, wearing/);
    expect(prompt).not.toMatch(/young|girl|pigtails/i);
  });
});

describe("planLongLiveRequest", () => {
  it("describes a wave as a concrete motion and never quotes the request", async () => {
    const { prompt, nextState } = await planLongLiveRequest(
      creator,
      state(),
      "wave at me",
    );
    expectCaption(prompt);
    expect(prompt).toContain("waves it side to side");
    expect(prompt).not.toContain("wave at me");
    expect(prompt).not.toContain("black lace bra");
    expect(nextState.wardrobe).toEqual(wardrobe());
  });

  it("describes a bra removal literally and advances the wardrobe", async () => {
    const {
      fallbackPrompt: prompt,
      settlePrompt,
      nextState,
    } = await planLongLiveRequest(
      creator,
      state({
        wardrobe: wardrobe({
          top: { on: false, description: "black ribbed tank top" },
          removedOrder: ["top"],
        }),
      }),
      "take your bra off",
    );
    expectCaption(prompt);
    expect(prompt).toContain("unhooks her black lace bra");
    expect(prompt).toContain("visible nipples");
    expect(nextState.wardrobe.bra.on).toBe(false);
    expect(settlePrompt).not.toMatch(UNDRESS_WORDS);
    expect(settlePrompt).toContain("playing with a strand of her hair");
  });

  it("plays stand up even when the guessed pose already says standing", async () => {
    const standing = state({
      body: { ...state().body, pose: "standing" },
    });
    const { prompt } = await planLongLiveRequest(creator, standing, "stand up");
    expect(prompt).toContain("stands tall");
  });

  it("describes a spin as turning all the way around", async () => {
    const { prompt } = await planLongLiveRequest(
      creator,
      state(),
      "spin around",
    );
    expect(prompt).toContain("turns slowly all the way around");
  });

  it("does not quote a negated wardrobe request, since the words themselves cue the model", async () => {
    const { prompt, nextState } = await planLongLiveRequest(
      creator,
      state(),
      "don't take your top off",
    );
    expect(prompt).not.toContain("don't take your top off");
    expect(prompt).not.toMatch(UNDRESS_WORDS);
    expectCaption(prompt);
    expect(nextState.wardrobe.top.on).toBe(true);
  });

  it("does not replay a removal for a garment that is already off", async () => {
    const current = state({
      wardrobe: wardrobe({
        bra: { on: false, description: "black lace bra" },
        removedOrder: ["bra"],
      }),
    });
    const { prompt } = await planLongLiveRequest(
      creator,
      current,
      "take your bra off",
    );
    expect(prompt).not.toMatch(UNDRESS_WORDS);
  });

  it("puts a garment back on and restores it in the next state", async () => {
    const current = state({
      wardrobe: wardrobe({
        top: { on: false, description: "black ribbed tank top" },
        removedOrder: ["top"],
      }),
    });
    const { fallbackPrompt: prompt, nextState } = await planLongLiveRequest(
      creator,
      current,
      "put your top back on",
    );
    expect(prompt).toContain("picks up her black ribbed tank top");
    expect(nextState.wardrobe.top.on).toBe(true);
  });

  it("trims an overlong room at a sentence end and keeps the action", async () => {
    const current = state({ surroundings: "A very long room. ".repeat(80) });
    const { prompt } = await planLongLiveRequest(
      creator,
      current,
      "wave at me",
    );
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(prompt).toContain("waves it side to side");
    expectCaption(prompt);
  });

  it("uses the LLM sentence when it is one clean positive sentence", async () => {
    create.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '{"sentence":"She raises both arms above her head and waves them slowly, smiling at the camera."}',
          },
        },
      ],
    });
    const { prompt } = await planLongLiveRequest(creator, state(), "wave");
    expect(prompt).toContain("raises both arms above her head");
  });

  it("keeps the camera but drops the word webcam from a captured room", async () => {
    const current = state({
      surroundings: "A desk with a laptop webcam angle and a lamp.",
    });
    const { prompt } = await planLongLiveRequest(creator, current, "wave");
    expect(prompt).toContain("a laptop camera angle");
    expectCaption(prompt);
  });

  it("lists the garments a request changes, for the vision check", async () => {
    const { wardrobeCheck } = await planLongLiveRequest(
      creator,
      state(),
      "strip",
    );
    expect(wardrobeCheck.sort()).toEqual(["bottom", "bra", "panties", "top"]);
    const wave = await planLongLiveRequest(creator, state(), "wave");
    expect(wave.wardrobeCheck).toEqual([]);
  });

  it("names observed clothing on an ask that leaves it alone, never on one that changes it", async () => {
    const wave = await planLongLiveRequest(creator, state(), "wave", {
      wardrobeObserved: true,
    });
    expect(wave.prompt).toContain("wearing her black ribbed tank top");
    expect(wave.settlePrompt).toContain("wearing her black ribbed tank top");
    const strip = await planLongLiveRequest(
      creator,
      state(),
      "take your top off",
      {
        wardrobeObserved: true,
      },
    );
    expect(strip.fallbackPrompt).not.toContain("wearing");
    expect(strip.settlePrompt).not.toContain("wearing");
  });

  it("hands a removal to a clip and gives the stream a lead-in that leaves her clothes alone", async () => {
    const step = await planLongLiveRequest(
      creator,
      state(),
      "take your top off",
      {
        wardrobeObserved: true,
      },
    );
    expect(step.handoff).toBe(true);
    expectCaption(step.prompt);
    expect(step.prompt).not.toMatch(UNDRESS_WORDS);
    expect(step.prompt).toContain("wearing her black ribbed tank top");
    expect(step.prompt).toContain("getting ready");
    expect(step.fallbackPrompt).toContain("tank top up over her head");
    expect(step.nextState.wardrobe.top.on).toBe(false);
  });

  it("keeps easy asks on the stream with the action as both prompts", async () => {
    const step = await planLongLiveRequest(creator, state(), "wave at me");
    expect(step.handoff).toBe(false);
    expect(step.prompt).toBe(step.fallbackPrompt);
  });

  it("never hands a request with a minor cue to a clip", async () => {
    const step = await planLongLiveRequest(
      creator,
      state(),
      "take your top off like a schoolgirl",
    );
    expect(step.handoff).toBe(false);
  });
});

describe("needsClipHandoff", () => {
  const kneeling = state({ body: { ...state().body, pose: "kneeling" } });

  it("sends wardrobe changes and prop use to a clip", () => {
    expect(
      needsClipHandoff([{ type: "removeGarment", garment: "bra" }], state()),
    ).toBe(true);
    expect(
      needsClipHandoff([{ type: "addGarment", garment: "top" }], state()),
    ).toBe(true);
    expect(
      needsClipHandoff([{ type: "fetchProp", prop: "vibrator" }], state()),
    ).toBe(true);
    expect(
      needsClipHandoff([{ type: "useProp", mode: "external" }], state()),
    ).toBe(true);
  });

  it("sends a change into a floor pose to a clip, but not standing, sitting or a pose she already holds", () => {
    for (const pose of [
      "onAllFours",
      "bentOver",
      "kneeling",
      "lying",
    ] as const) {
      expect(
        needsClipHandoff([{ type: "pose", pose, facing: "camera" }], state()),
      ).toBe(true);
    }
    expect(
      needsClipHandoff(
        [{ type: "pose", pose: "standing", facing: "camera" }],
        state(),
      ),
    ).toBe(false);
    expect(
      needsClipHandoff(
        [{ type: "pose", pose: "sitting", facing: "camera" }],
        kneeling,
      ),
    ).toBe(false);
    expect(
      needsClipHandoff(
        [{ type: "pose", pose: "kneeling", facing: "camera" }],
        kneeling,
      ),
    ).toBe(false);
  });

  it("sends spanking and doggy to a clip and keeps the rest of the act catalogue on the stream", () => {
    expect(needsClipHandoff([{ type: "act", act: "spank" }], state())).toBe(
      true,
    );
    expect(needsClipHandoff([{ type: "act", act: "doggy" }], state())).toBe(
      true,
    );
    for (const act of [
      "sway",
      "gesture",
      "tongue",
      "boobPlay",
      "twerk",
    ] as const) {
      expect(needsClipHandoff([{ type: "act", act }], state())).toBe(false);
    }
  });

  it("keeps talk and easy gestures on the stream", () => {
    expect(needsClipHandoff([], state())).toBe(false);
    expect(needsClipHandoff([{ type: "hold", line: "hi" }], state())).toBe(
      false,
    );
    expect(needsClipHandoff([{ type: "touch" }], state())).toBe(false);
    expect(
      needsClipHandoff([{ type: "verbatim", text: "wink" }], state()),
    ).toBe(false);
    expect(
      needsClipHandoff([{ type: "framing", framing: "torso" }], state()),
    ).toBe(false);
  });

  it("hands off when any one of several intents is hard", () => {
    expect(
      needsClipHandoff(
        [
          { type: "act", act: "gesture" },
          { type: "removeGarment", garment: "top" },
        ],
        state(),
      ),
    ).toBe(true);
  });
});

describe("planLongLiveSettle", () => {
  const topless = state({
    wardrobe: wardrobe({
      top: { on: false, description: "black ribbed tank top" },
      bottom: { on: false, description: "denim shorts" },
      bra: { on: false, description: "black lace bra" },
      removedOrder: ["top", "bottom", "bra"],
    }),
  });

  it("names confirmed clothing positively", () => {
    const prompt = planLongLiveSettle(creator, topless, true);
    expect(prompt).toContain("topless, wearing only her black lace panties");
    expectCaption(prompt);
  });

  it("says nothing about clothing that has not been seen", () => {
    expect(planLongLiveSettle(creator, topless, false)).not.toMatch(
      /wearing|topless/,
    );
  });

  it("names her fully naked once nothing is on", () => {
    const naked = state({
      wardrobe: wardrobe({
        top: { on: false, description: "black ribbed tank top" },
        bottom: { on: false, description: "denim shorts" },
        bra: { on: false, description: "black lace bra" },
        panties: { on: false, description: "black lace panties" },
        removedOrder: ["top", "bottom", "bra", "panties"],
      }),
    });
    expect(planLongLiveSettle(creator, naked, true)).toContain(
      "An adult woman with long wavy auburn hair, freckles, green eyes, slim build, fully naked.",
    );
  });
});

describe("planLongLiveCheckIn", () => {
  it("looks back to the fan and changes nothing", () => {
    const step = planLongLiveCheckIn(creator, state(), false);
    expectCaption(step.prompt);
    expect(step.prompt).toContain("looks back into the camera");
    expect(step.nextState).toEqual(state());
    expect(step.wardrobeCheck).toEqual([]);
  });
});
