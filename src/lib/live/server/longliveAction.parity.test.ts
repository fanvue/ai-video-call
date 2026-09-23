// Every action clip mode can plan must reach LongLive as its own motion sentence, so a new clip action cannot silently miss it.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TIP_MENU } from "@/lib/live/client/defaultCreatorProfile";
import {
  beatIntentSchema,
  bodySchema,
  garmentIdSchema,
  poseSchema,
  type BeatIntent,
  type Body,
  type LiveState,
} from "../contract";

vi.mock("@/lib/groq", () => ({
  GROQ_TEXT_MODEL: "test-model",
  createGroqChatCompletion: () => Promise.reject(new Error("groq down")),
}));

const { REACT_ACTION, templateAction } = await import("./longliveAction");
const { resolveIntents } = await import("./planClip");

const body: Body = {
  pose: "sitting",
  facing: "camera",
  hands: "free",
  contact: "none",
  prop: "none",
  framing: "medium",
};

// The session's opening wardrobe (reference route DEFAULT_WARDROBE), with a top and bottoms to take off.
const dressed: LiveState = {
  wardrobe: {
    top: { on: true, description: "white crop top" },
    bottom: { on: true, description: "denim skirt" },
    bra: { on: true, description: "white lace bra" },
    panties: { on: true, description: "white lace panties" },
    removedOrder: [],
  },
  body,
  baselineBody: body,
  world: "w",
  surroundings: "A bedroom.",
};

const undressed: LiveState = {
  ...dressed,
  wardrobe: {
    top: { ...dressed.wardrobe.top, on: false },
    bottom: { ...dressed.wardrobe.bottom, on: false },
    bra: { ...dressed.wardrobe.bra, on: false },
    panties: { ...dressed.wardrobe.panties, on: false },
    removedOrder: ["top", "bottom", "bra", "panties"],
  },
};

const lingerie: LiveState = {
  ...dressed,
  wardrobe: {
    ...dressed.wardrobe,
    top: { on: false, description: "top" },
    bottom: { on: false, description: "bottoms" },
    removedOrder: [],
  },
};

const withBody = (state: LiveState, patch: Partial<Body>): LiveState => ({
  ...state,
  body: { ...state.body, ...patch },
});

const shapeOf = <T extends BeatIntent["type"]>(type: T) => {
  const option = beatIntentSchema.options.find(
    (candidate) => candidate.shape.type.value === type,
  );
  if (!option) throw new Error(`no ${type} intent in the contract`);
  return option.shape as Record<string, { options?: readonly string[] }>;
};

const optionsOf = (type: BeatIntent["type"], field: string): string[] => [
  ...(shapeOf(type)[field]?.options ?? []),
];

type Case = { name: string; intent: BeatIntent; state: LiveState };

const poses = poseSchema.options;

const cases: Case[] = [
  ...garmentIdSchema.options.flatMap((garment) =>
    poses.flatMap((pose) => [
      {
        name: `removeGarment ${garment} from ${pose}`,
        intent: { type: "removeGarment", garment } as BeatIntent,
        state: withBody(dressed, { pose }),
      },
      {
        name: `addGarment ${garment} from ${pose}`,
        intent: { type: "addGarment", garment } as BeatIntent,
        state: withBody(undressed, { pose }),
      },
    ]),
  ),
  ...poses.flatMap((pose) =>
    bodySchema.shape.facing.options.map((facing) => ({
      name: `pose ${pose} ${facing}`,
      intent: { type: "pose", pose, facing } as BeatIntent,
      state: dressed,
    })),
  ),
  ...bodySchema.shape.framing.options.map((framing) => ({
    name: `framing ${framing}`,
    intent: { type: "framing", framing } as BeatIntent,
    state: dressed,
  })),
  ...optionsOf("fetchProp", "prop").map((prop) => ({
    name: `fetchProp ${prop}`,
    intent: { type: "fetchProp", prop } as BeatIntent,
    state: dressed,
  })),
  ...optionsOf("useProp", "mode").flatMap((mode) => [
    {
      name: `useProp ${mode} holding the vibrator`,
      intent: { type: "useProp", mode } as BeatIntent,
      state: withBody(dressed, { prop: "vibrator", hands: "holdingProp" }),
    },
    {
      name: `useProp ${mode} empty-handed`,
      intent: { type: "useProp", mode } as BeatIntent,
      state: dressed,
    },
  ]),
  {
    name: "rest from a held prop, off baseline",
    intent: { type: "rest" },
    state: withBody(dressed, {
      pose: "kneeling",
      facing: "away",
      prop: "dildo",
      hands: "holdingProp",
    }),
  },
  { name: "rest at baseline", intent: { type: "rest" }, state: dressed },
  ...poses.flatMap((pose) =>
    [dressed, undressed].map((state) => ({
      name: `touch from ${pose}${state === undressed ? " bare" : ""}`,
      intent: { type: "touch" } as BeatIntent,
      state: withBody(state, { pose }),
    })),
  ),
  ...optionsOf("act", "act").flatMap((act) =>
    poses.flatMap((pose) =>
      [dressed, undressed].map((state) => ({
        name: `act ${act} from ${pose}${state === undressed ? " bare" : ""}`,
        intent: { type: "act", act } as BeatIntent,
        state: withBody(state, { pose }),
      })),
    ),
  ),
  ...["ass", "legs"].map((detail) => ({
    name: `act spread ${detail}`,
    intent: { type: "act", act: "spread", detail } as BeatIntent,
    state: dressed,
  })),
  ...["strap", "waistband", "hem"].map((detail) => ({
    name: `act tease ${detail}`,
    intent: {
      type: "act",
      act: "tease",
      detail: `She plays with her ${detail}.`,
    } as BeatIntent,
    state: dressed,
  })),
  {
    name: "hold with a physical line",
    intent: { type: "hold", line: "She takes a small sip, unhurried." },
    state: dressed,
  },
  {
    name: "verbatim",
    intent: { type: "verbatim", text: "run your hands through your hair" },
    state: dressed,
  },
];

// A clip-mode timecode, a negation or a named overlay would steer the video model toward the wrong thing.
const TIMECODE_RE = /\d+-\d+s\b/;
const NEGATION_RE = /\b(not|no|never|without|nothing)\b|n't\b/i;

const expectMotion = (sentence: string) => {
  expect(sentence).not.toBe(REACT_ACTION);
  expect(sentence).toMatch(/^[A-Z][^]*[.!]$/);
  expect(sentence).not.toMatch(TIMECODE_RE);
  expect(sentence).not.toMatch(NEGATION_RE);
};

describe("LongLive action parity with clip mode", () => {
  it("enumerates every intent type and every act in the contract", () => {
    const types = new Set(cases.map((c) => c.intent.type));
    expect([...types].sort()).toEqual(
      beatIntentSchema.options.map((o) => o.shape.type.value).sort(),
    );
    const acts = new Set(
      cases.flatMap((c) => (c.intent.type === "act" ? [c.intent.act] : [])),
    );
    expect([...acts].sort()).toEqual(optionsOf("act", "act").sort());
  });

  it.each(cases)("$name plays its own motion", ({ intent, state }) => {
    const plan = templateAction("", [intent], state);
    expect(plan.physical).toBe(true);
    expectMotion(plan.sentence);
  });

  it.each(DEFAULT_TIP_MENU)(
    "tip menu $id plays its own motion from the opening wardrobe",
    ({ request }) => {
      const plan = templateAction(
        request,
        resolveIntents(request, lingerie.wardrobe, lingerie.body),
        lingerie,
      );
      expect(plan.physical).toBe(true);
      expectMotion(plan.sentence);
    },
  );

  // The quick tip's "tips N coins" misses clip mode's RE_TIP too, so both play a friendly reaction; a thank-you plays her kiss.
  it("plays a thank-you as clip mode's tip beat", () => {
    const text = "thank you for the show";
    const plan = templateAction(
      text,
      resolveIntents(text, lingerie.wardrobe, lingerie.body),
      lingerie,
    );
    expectMotion(plan.sentence);
    expect(plan.sentence).toContain("blows one kiss");
  });

  it("keeps small talk on the reaction, the one deliberate fallback", () => {
    const text = "how is your day going";
    expect(
      templateAction(
        text,
        resolveIntents(text, lingerie.wardrobe, lingerie.body),
        lingerie,
      ),
    ).toEqual({ sentence: REACT_ACTION, physical: false });
  });

  it("leads in the way clip mode does: sets a prop down, sits up, rises", () => {
    const holding = withBody(lingerie, {
      pose: "lying",
      prop: "vibrator",
      hands: "holdingProp",
    });
    const panties = templateAction(
      "",
      [{ type: "removeGarment", garment: "panties" }],
      holding,
    ).sentence;
    expect(panties).toMatch(
      /^She sets her vibrator aside, then she sits up on the edge of the bed, then she hooks her thumbs/,
    );
    expect(
      templateAction("", [{ type: "act", act: "dance" }], lingerie).sentence,
    ).toMatch(/^She stands up onto her feet, then she dances/);
  });

  it("reads each step from the body the previous one left", () => {
    const sentence = templateAction(
      "",
      [
        { type: "fetchProp", prop: "vibrator" },
        { type: "useProp", mode: "mouth" },
      ],
      lingerie,
    ).sentence;
    expect(sentence).toContain("licks and sucks its tip");
    expect(sentence).toContain("her vibrator to her mouth");
  });
});
