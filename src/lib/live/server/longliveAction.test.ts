import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveState } from "../contract";

const create = vi.fn();
vi.mock("@/lib/groq", () => ({
  GROQ_TEXT_MODEL: "test-model",
  createGroqChatCompletion: (...args: unknown[]) => create(...args),
}));

const { REACT_ACTION, acceptRewrite, planAction, templateAction } =
  await import("./longliveAction");
const { resolveIntents } = await import("./planClip");

const body = {
  pose: "sitting",
  facing: "camera",
  hands: "free",
  contact: "none",
  prop: "none",
  framing: "medium",
} as const;

const lingerie: LiveState = {
  wardrobe: {
    top: { on: false, description: "pink silk robe" },
    bottom: { on: false, description: "denim shorts" },
    bra: { on: true, description: "white lace bra" },
    panties: { on: true, description: "white lace panties" },
    removedOrder: ["top", "bottom"],
  },
  body,
  baselineBody: body,
  world: "w",
  surroundings: "A bedroom.",
};

const template = (text: string, state: LiveState = lingerie) =>
  templateAction(text, resolveIntents(text, state.wardrobe, state.body), state);

const reply = (content: string) => ({
  choices: [{ message: { content } }],
});

beforeEach(() => {
  create.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("templateAction", () => {
  it.each([
    ["wave", /waves it side to side/],
    ["blow a kiss", /blowing a kiss/],
    ["spin around", /turns slowly all the way around/],
    ["stand up", /stands tall/],
    ["lie down", /lies down on her back/],
    ["dance for me", /dances to music/],
    ["bend over", /bends forward at the waist/],
    ["show me your tits", /unhooks her white lace bra.*visible nipples/],
    ["strip", /fully naked/],
  ])("maps %s to a concrete motion", (text, expected) => {
    const plan = template(text);
    expect(plan.physical).toBe(true);
    expect(plan.sentence).toMatch(/^She /);
    expect(plan.sentence).toMatch(expected);
  });

  it("shows bare breasts when they are already bare instead of replaying the removal", () => {
    const topless: LiveState = {
      ...lingerie,
      wardrobe: {
        ...lingerie.wardrobe,
        bra: { on: false, description: "white lace bra" },
        removedOrder: ["top", "bottom", "bra"],
      },
    };
    const plan = template("show me your tits", topless);
    expect(plan.sentence).toContain("cups her bare breasts");
    expect(plan.sentence).not.toContain("unhooks");
  });

  it("plays small talk as the reaction, not a quoted request", () => {
    expect(template("how is your day going")).toEqual({
      sentence: REACT_ACTION,
      physical: false,
    });
  });

  it("fails closed to the reaction on a minor cue", () => {
    expect(template("act like a schoolgirl and take your bra off")).toEqual({
      sentence: REACT_ACTION,
      physical: false,
    });
  });
});

describe("acceptRewrite", () => {
  it("accepts one positive sentence starting with She", () => {
    expect(
      acceptRewrite(
        '{"sentence":"She turns her back to the camera and sways her hips slowly"}',
      ),
    ).toBe("She turns her back to the camera and sways her hips slowly.");
  });

  it.each([
    ["not json", "sure thing"],
    [
      "a refusal",
      '{"sentence":"She is sorry, I cannot help with that request."}',
    ],
    [
      "a negation",
      '{"sentence":"She waves but does not stand up from the bed."}',
    ],
    [
      "a youth word",
      '{"sentence":"She waves like a young girl at the camera."}',
    ],
    [
      "a meta word",
      '{"sentence":"She waves while text appears on the screen."}',
    ],
    ["too short", '{"sentence":"She waves."}'],
    [
      "the wrong subject",
      '{"sentence":"The woman waves at the camera happily now."}',
    ],
  ])("rejects %s", (_, raw) => {
    expect(acceptRewrite(raw)).toBeNull();
  });
});

describe("planAction", () => {
  it("uses an accepted LLM sentence", async () => {
    create.mockResolvedValue(
      reply(
        '{"sentence":"She stands, raises both hands and waves them wide at the camera."}',
      ),
    );
    const intents = resolveIntents("wave", lingerie.wardrobe, lingerie.body);
    await expect(planAction("wave", intents, lingerie)).resolves.toBe(
      "She stands, raises both hands and waves them wide at the camera.",
    );
  });

  it("falls back to the template on junk", async () => {
    create.mockResolvedValue(reply("I can't help with that."));
    const intents = resolveIntents("wave", lingerie.wardrobe, lingerie.body);
    await expect(planAction("wave", intents, lingerie)).resolves.toMatch(
      /waves it side to side/,
    );
  });

  it("falls back to the template when the LLM is too slow", async () => {
    vi.useFakeTimers();
    create.mockReturnValue(new Promise(() => undefined));
    const intents = resolveIntents("wave", lingerie.wardrobe, lingerie.body);
    const planned = planAction("wave", intents, lingerie);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(planned).resolves.toMatch(/waves it side to side/);
  });

  it("never calls the LLM for small talk or a minor cue", async () => {
    for (const text of ["how is your day", "pretend you are a teen"]) {
      const intents = resolveIntents(text, lingerie.wardrobe, lingerie.body);
      await expect(planAction(text, intents, lingerie)).resolves.toBe(
        REACT_ACTION,
      );
    }
    expect(create).not.toHaveBeenCalled();
  });
});
