import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionSnapshot } from "../contract";

const createGroqChatCompletion = vi.fn();
vi.mock("@/lib/groq", () => ({
  GROQ_TEXT_MODEL: "openai/gpt-oss-120b",
  createGroqChatCompletion: (...args: unknown[]) =>
    createGroqChatCompletion(...args),
  stripThinkBlock: (raw: string) =>
    raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
}));
const createOpenRouterCompletion = vi.fn();
vi.mock("@/lib/openrouter", () => ({
  createOpenRouterCompletion: (...args: unknown[]) =>
    createOpenRouterCompletion(...args),
}));

const {
  DIRECTOR_MODEL,
  buildDirectorPrompt,
  directClip,
  directorClipPlan,
  directorInputFor,
  hardLimitHold,
  judgeDirectorOutput,
  validateDirectorPlan,
} = await import("./directClip");
const { DIRECTOR_EXAMPLES, DIRECTOR_SYSTEM_PROMPT } =
  await import("./directorPrompt");

type Plan = Parameters<typeof validateDirectorPlan>[0];

const example = (i: number) => {
  const found = DIRECTOR_EXAMPLES[i];
  if (!found) throw new Error(`no example ${i}`);
  return {
    input: found.input,
    output: structuredClone(found.output) as Plan,
  };
};

// Example 3's own frame 0 (hoodie off and lying in the room, red satin bra and panties on), so its gold output is valid here.
const session: LiveSessionSnapshot = {
  creator: {
    id: "creator-1",
    displayName: "Aria",
    lookLock: "long dark wavy hair, olive skin, athletic build",
    sceneId: "bedroom",
    tipMenu: [],
  },
  state: {
    wardrobe: {
      top: { on: false, description: "grey hoodie" },
      bottom: { on: false, description: "bottoms" },
      bra: { on: true, description: "red satin bra" },
      panties: { on: true, description: "red satin panties" },
      removedOrder: ["top"],
    },
    body: {
      pose: "sitting",
      facing: "camera",
      hands: "free",
      contact: "none",
      prop: "none",
      framing: "medium",
    },
    baselineBody: {
      pose: "sitting",
      facing: "camera",
      hands: "free",
      contact: "none",
      prop: "none",
      framing: "medium",
    },
    world: "teasing, took her hoodie off a minute ago",
    surroundings: example(2).input.room,
  },
  seedFrameUrl: "https://example.com/seed.png",
  anchorFrameUrl: "https://example.com/anchor.png",
  elapsedSec: 120,
  transcript: [
    {
      id: "t1",
      role: "viewer",
      handle: "someone",
      channel: "chat",
      text: "take the hoodie off",
      atSec: 60,
    },
  ],
};

const reply = (text: string) => ({
  kind: "reply" as const,
  requestId: "r1",
  text,
  channel: "chat" as const,
  from: "fan" as const,
  precededByIdle: false,
});

const groqReturns = (...contents: string[]) => {
  for (const content of contents) {
    createGroqChatCompletion.mockResolvedValueOnce({
      choices: [{ message: { content } }],
    });
  }
};

const direct = (text: string, backend: "swap" | "wan14b" = "swap") =>
  directClip({
    session,
    job: reply(text),
    speechMode: "text",
    backend,
  });

const GOLD = JSON.stringify(example(2).output);

beforeEach(() => {
  createGroqChatCompletion.mockReset();
  createOpenRouterCompletion.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Director system prompt", () => {
  it("holds every worked example to the schema, the validator and the prompt's own lengths", () => {
    expect(DIRECTOR_EXAMPLES.length).toBeGreaterThanOrEqual(3);
    for (const { input, output } of DIRECTOR_EXAMPLES) {
      const outcome = judgeDirectorOutput(JSON.stringify(output), input);
      expect(outcome).toMatchObject({ kind: "plan" });
      const plan = output as Plan;
      expect(plan.beats.every((beat) => beat.action.length <= 240)).toBe(true);
      expect(plan.interpretation.every((part) => part.length <= 80)).toBe(true);
      expect(plan.reconciliation.length).toBeLessThanOrEqual(300);
      expect(plan.endDescription.length).toBeLessThanOrEqual(200);
    }
  });

  it("covers the composite, the off-screen fetch and a garment removal plus an act", () => {
    const [composite, fetch, removal] = DIRECTOR_EXAMPLES.map(
      (e) => e.output as Plan,
    );
    expect(composite?.props[0]).toMatchObject({
      kind: "dildo",
      source: "offscreen",
    });
    expect(composite?.endState.pose).toBe("onAllFours");
    expect(fetch?.props[0]).toMatchObject({
      source: "offscreen",
      ends: "placed",
    });
    expect(
      removal?.beats.some((beat) =>
        beat.wardrobe?.some((c) => c.garment === "bra"),
      ),
    ).toBe(true);
    expect(removal?.endState.contact).toBe("self");
  });

  it("has no em dashes", () => {
    expect(DIRECTOR_SYSTEM_PROMPT).not.toMatch(/[\u2014\u2013]/);
  });
});

describe("validateDirectorPlan", () => {
  const errorsFor = (mutate: (plan: Plan) => void, i = 2) => {
    const { input, output } = example(i);
    mutate(output);
    return validateDirectorPlan(output, input);
  };

  it("accepts the gold plan", () => {
    expect(errorsFor(() => undefined)).toEqual([]);
  });

  it("rejects beats that are not contiguous from 0 to the clip length", () => {
    expect(
      errorsFor((plan) => {
        plan.beats[1]!.fromSec = 4;
      }),
    ).toContain("beats[1].fromSec must equal beats[0].toSec");
    expect(
      errorsFor((plan) => {
        plan.beats[4]!.toSec = 9;
      }).join(" "),
    ).toMatch(/end after it starts|must end at 10/);
  });

  it("wants a still last beat with no garment change", () => {
    expect(
      errorsFor((plan) => {
        plan.beats[4]!.wardrobe = [{ garment: "panties", to: "off" }];
        plan.endState.wardrobe.panties = false;
      }),
    ).toContain(
      "the last beat must be a still hold of at least 1 s with no garment change",
    );
  });

  it("only takes off what she wears and only puts on what lies in the room", () => {
    expect(
      errorsFor((plan) => {
        plan.beats[2]!.wardrobe = [{ garment: "bottom", to: "off" }];
      }),
    ).toContain("beats[2]: bottom is not on, so it cannot come off");
    expect(
      errorsFor((plan) => {
        plan.beats[2]!.wardrobe = [
          { garment: "bra", to: "off" },
          { garment: "top", to: "on" },
          { garment: "bra", to: "on" },
        ];
        plan.endState.wardrobe.top = true;
        plan.endState.wardrobe.bra = true;
      }),
    ).toContain("beats[2]: the bra goes on before the top");
    expect(
      errorsFor((plan) => {
        plan.beats[3]!.wardrobe = [{ garment: "bottom", to: "on" }];
        plan.endState.wardrobe.bottom = true;
      }),
    ).toContain(
      "beats[3]: bottom is not lying in the room, so it cannot go on",
    );
  });

  it("keeps the bottoms before the panties", () => {
    expect(
      errorsFor((plan) => {
        plan.beats[0]!.wardrobe = [{ garment: "panties", to: "off" }];
        plan.beats[1]!.wardrobe = [{ garment: "bottom", to: "off" }];
      }, 3),
    ).toContain("beats[0]: the bottom comes off before the panties");
  });

  it("holds endState to the beats' wardrobe changes and framing", () => {
    expect(
      errorsFor((plan) => {
        plan.endState.wardrobe.bra = true;
      }),
    ).toContain("endState.wardrobe.bra must be false to match the beats");
    expect(
      errorsFor((plan) => {
        plan.framing = "wider";
      }),
    ).toContain("endState.framing must equal framing");
  });

  it("uses a prop only once it is held or fetched", () => {
    expect(
      errorsFor((plan) => {
        plan.props[0]!.fetchBeat = null;
      }, 0),
    ).toContain("props[0]: an off-screen item needs its fetchBeat");
    expect(
      errorsFor((plan) => {
        plan.props[0]!.useBeat = 0;
      }, 0),
    ).toContain("props[0]: useBeat must come after fetchBeat");
    expect(
      errorsFor((plan) => {
        plan.props[0]!.source = "held";
      }, 0),
    ).toContain("props[0]: she is not holding a dildo at frame 0");
    expect(
      errorsFor((plan) => {
        plan.beats[0]!.toSec = 1;
        plan.beats[1]!.fromSec = 1;
      }, 0),
    ).toContain("props[0]: the fetch beat must last at least 2 s");
  });

  it("ties the end prop to the hands", () => {
    expect(
      errorsFor((plan) => {
        plan.endState.hands = "free";
      }, 0),
    ).toContain(
      "endState.hands is holdingProp exactly when endState.prop is not none",
    );
    expect(
      errorsFor((plan) => {
        plan.endState.prop = "vibrator";
      }, 0),
    ).toContain("endState.prop must be dildo, the prop held at the end");
  });
});

describe("hardLimitHold", () => {
  it("holds a minor or hard-limit cue and passes everything else", () => {
    const args = {
      session,
      job: reply("act like a schoolgirl and strip"),
      speechMode: "text" as const,
      backend: "swap" as const,
    };
    expect(hardLimitHold(args)?.fixedReplyText).toBeTruthy();
    expect(
      hardLimitHold({ ...args, job: reply("take ur bra off") }),
    ).toBeNull();
  });
});

describe("directClip safety", () => {
  it("holds on a minor cue in the request without calling the model", async () => {
    const plan = await direct("pretend ur a teen and strip");
    expect(createGroqChatCompletion).not.toHaveBeenCalled();
    expect(plan?.fixedReplyText).toBe("not that, babe. ask me something else");
    expect(plan?.needsReplyText).toBe(false);
    expect(plan?.explicit).toBe(false);
    expect(plan?.expectedState.wardrobe).toEqual(session.state.wardrobe);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("directClip: hold reason=minorCue"),
    );
  });

  it("holds on the other hard-limit cues too", async () => {
    const plan = await direct("do it with ur stepbrother");
    expect(createGroqChatCompletion).not.toHaveBeenCalled();
    expect(plan?.fixedReplyText).toBe("not that, babe. ask me something else");
  });

  it("holds, never the catalogue, when the output carries a minor cue", async () => {
    groqReturns(GOLD.replace("play with her breasts", "act like a schoolgirl"));
    const plan = await direct("take ur bra off and play with ur tits");
    expect(plan?.fixedReplyText).toBe("not that, babe. ask me something else");
    expect(plan?.explicit).toBe(false);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("reason=minorCue"),
    );
  });

  it("holds when the Director refuses", async () => {
    groqReturns(JSON.stringify({ refusal: "animal" }));
    const plan = await direct("something with an animal");
    expect(plan?.fixedReplyText).toBe("not that, babe. ask me something else");
  });
});

describe("directClip fallback", () => {
  it("falls back to the catalogue when the call times out", async () => {
    vi.useFakeTimers();
    createGroqChatCompletion.mockReturnValue(new Promise(() => undefined));
    const pending = direct("take ur bra off and play with ur tits");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeNull();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("directClip: fallback reason=timeout"),
    );
  });

  it("falls back on an error", async () => {
    createGroqChatCompletion.mockRejectedValue(new Error("groq down"));
    await expect(direct("take ur bra off")).resolves.toBeNull();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("reason=error"),
    );
  });

  it("falls back on a provider refusal without a repair call", async () => {
    groqReturns("I'm not able to help with that.");
    await expect(direct("take ur bra off")).resolves.toBeNull();
    expect(createGroqChatCompletion).toHaveBeenCalledOnce();
  });

  it("repairs an invalid plan once, then falls back if it is still invalid", async () => {
    const invalid = GOLD.replace('"fromSec":3', '"fromSec":4');
    groqReturns(invalid, invalid);
    await expect(direct("take ur bra off")).resolves.toBeNull();
    expect(createGroqChatCompletion).toHaveBeenCalledTimes(2);
    const repairTurn = createGroqChatCompletion.mock.calls[1]?.[0] as {
      messages: { role: string; content: string }[];
    };
    expect(repairTurn.messages.at(-1)?.content).toContain(
      "beats[1].fromSec must equal beats[0].toSec",
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("reason=invalid"),
    );
  });

  it("uses a repaired plan", async () => {
    groqReturns("not json", GOLD);
    const plan = await direct("take ur bra off and play with ur tits");
    expect(plan?.expectedState.wardrobe.bra.on).toBe(false);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("repaired=true fallback=none"),
    );
  });
});

describe("directClip plan", () => {
  it("sends the system prompt first and the live state as the input", async () => {
    groqReturns(GOLD);
    await direct("take ur bra off and play with ur tits");
    const call = createGroqChatCompletion.mock.calls[0]?.[0] as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(`groq:${call.model}`).toBe(DIRECTOR_MODEL);
    expect(call.messages[0]).toEqual({
      role: "system",
      content: DIRECTOR_SYSTEM_PROMPT,
    });
    const input = JSON.parse(call.messages[1]?.content ?? "{}");
    expect(input).toMatchObject({
      clipSec: 10,
      now: {
        wardrobe: {
          top: { on: false, inRoom: true },
          bottom: { on: false, inRoom: false },
          bra: { on: true, inRoom: false },
        },
      },
      recentChat: [{ from: "viewer", text: "take the hoodie off" }],
      request: "take ur bra off and play with ur tits",
    });
    expect(call.messages[1]?.content).not.toContain("someone");
  });

  it("plans Premium clips at the Wan length", async () => {
    groqReturns(GOLD);
    await direct("take ur bra off", "wan14b");
    const call = createGroqChatCompletion.mock.calls[0]?.[0] as {
      messages: { content: string }[];
    };
    expect(JSON.parse(call.messages[1]?.content ?? "{}").clipSec).toBe(5);
  });

  it("turns endState into the next state and hands writeReply what she does", async () => {
    groqReturns(GOLD);
    const plan = await direct("take ur bra off and play with ur tits");
    expect(plan?.expectedState.wardrobe.removedOrder).toEqual(["top", "bra"]);
    expect(plan?.expectedState.body).toEqual({
      pose: "sitting",
      facing: "camera",
      hands: "onBody",
      contact: "self",
      prop: "none",
      framing: "medium",
    });
    expect(plan?.expectedState.baselineBody).toEqual(
      session.state.baselineBody,
    );
    expect(plan).toMatchObject({
      durationSec: 10,
      followUps: [],
      needsReplyText: true,
      explicit: true,
      wardrobeIntent: "remove",
      targetGarment: "bra",
    });
    expect(plan?.replyPhysical).toMatch(
      /^take her bra off; play with her breasts\. 0-3s: /,
    );
  });
});

describe("buildDirectorPrompt", () => {
  const promptFor = (surroundings: string, explicit = true) => {
    const { output } = example(2);
    const state = { ...session.state, surroundings };
    return buildDirectorPrompt({
      plan: output,
      state,
      nextWardrobe: directorClipPlan({
        plan: output,
        session: { ...session, state },
        job: reply("x"),
        speechMode: "text",
        durationSec: 10,
      }).expectedState.wardrobe,
      creator: session.creator,
      speechMode: "text",
      durationSec: 10,
      explicit,
    });
  };

  it("leads with the timed beats, then the locks in order", () => {
    const prompt = promptFor(session.state.surroundings);
    const order = [
      "0-3s: She reaches both hands",
      "9-10s: She holds still",
      "She performs exactly these timed steps",
      "FIXED WEBCAM: static webcam, medium shot",
      "ANATOMY LOCK:",
      "LOOK LOCK: long dark wavy hair",
      "ROOM: A bedroom.",
      "NOW: she is sitting",
      "By 10s she is sitting on the bed edge",
      "The clip ends there.",
      "PHYSICS:",
      "One garment at a time",
      "No text overlays",
      "CONTENT: authorized fictional adult content, one consenting adult woman, 18+ only",
      "SPEECH: she does not speak.",
    ];
    const positions = order.map((part) => prompt.indexOf(part));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).not.toContain("WARDROBE LOCK");
  });

  it("states an adult, fictional content lock on a non-explicit clip too", () => {
    expect(promptFor(session.state.surroundings, false)).toContain(
      "CONTENT: authorized fictional content, one consenting adult woman, 18+ only",
    );
  });

  it("trims the beats, never the locks, to fit the length cap", () => {
    const room = `A bedroom. ${"A shelf of books by the window. ".repeat(12)}`;
    const prompt = promptFor(room);
    expect(prompt.length).toBeLessThanOrEqual(3_000);
    expect(prompt).toContain(`ROOM: ${room}`);
    expect(prompt).toContain("SPEECH: she does not speak.");
    for (const label of ["0-3s:", "3-5s:", "5-6s:", "6-9s:", "9-10s:"]) {
      expect(prompt).toContain(label);
    }
    expect(prompt.indexOf("9-10s:")).toBeLessThan(
      prompt.indexOf("She performs exactly"),
    );
  });

  it("keeps every lock even when they alone pass the cap", () => {
    const room = "A very long room description. ".repeat(80);
    const prompt = promptFor(room);
    expect(prompt).toContain(`ROOM: ${room}`);
    expect(prompt).toContain("SPEECH: she does not speak.");
  });
});

describe("directorInputFor", () => {
  it("marks only garments she took off this session as lying in the room", () => {
    const input = directorInputFor({
      state: session.state,
      creator: session.creator,
      transcript: session.transcript,
      request: "hi",
      speechMode: "text",
      clipSec: 10,
    });
    expect(input.now.wardrobe.top.inRoom).toBe(true);
    expect(input.now.wardrobe.bottom.inRoom).toBe(false);
    expect(input.performer).toEqual({
      displayName: "Aria",
      look: session.creator.lookLock,
    });
  });
});

describe("validateDirectorPlan: framing, toys and visibility", () => {
  const errorsFor = (mutate: (plan: Plan) => void, i: number) => {
    const { input, output } = example(i);
    mutate(output);
    return validateDirectorPlan(output, input);
  };
  const withInput = (
    i: number,
    change: (input: ReturnType<typeof example>["input"]) => void,
  ) => {
    const { input, output } = example(i);
    const copy = structuredClone(input);
    change(copy);
    return { input: copy, output };
  };

  it("keeps the current framing unless the viewer asks her to come closer or step back", () => {
    const widened = (plan: Plan) => {
      plan.framing = "wider";
      plan.endState.framing = "wider";
    };
    expect(errorsFor(widened, 0)).toContain(
      "framing must stay medium: she moves nearer or farther only when the viewer asks her to come closer or step back",
    );
    expect(
      errorsFor((plan) => {
        widened(plan);
        plan.interpretation.push("step back from the camera");
      }, 0),
    ).toEqual([]);
  });

  it("never fetches a toy that is already in the scene", () => {
    const { input, output } = withInput(0, (copy) => {
      copy.now.props = [
        {
          item: "pink silicone dildo",
          kind: "dildo",
          at: "placed",
          where: "on the duvet beside her left knee",
        },
      ];
    });
    expect(validateDirectorPlan(output, input)).toContain(
      "props[0]: the pink silicone dildo is already on the duvet beside her left knee; use that one instead of fetching another",
    );
  });

  it("allows one entry per toy", () => {
    expect(
      errorsFor((plan) => {
        plan.props.push({
          ...plan.props[0]!,
          ends: "placed",
          endsWhere: "on the duvet",
        });
      }, 0),
    ).toContain("only one of each prop exists: one props entry per kind");
  });

  it("wants the toy drawn out and held in a named hand by the last beat", () => {
    expect(
      errorsFor((plan) => {
        plan.beats[plan.beats.length - 1]!.action =
          "She holds still on all fours, right hand still holding the dildo inside her, eyes on the lens.";
      }, 4),
    ).toContain(
      "by the last beat the toy is drawn out of her and held in a named hand or set down on a named surface, never inside her, at her mouth or against her",
    );
    expect(
      errorsFor((plan) => {
        plan.props[0]!.endsWhere =
          "the dildo half-inserted and resting in her hand";
      }, 4).join(" "),
    ).toMatch(/drawn out of her.*props\[0\]\.endsWhere must name the hand/);
  });

  it("puts penetration from all fours with her back or side to the lens", () => {
    expect(
      errorsFor((plan) => {
        plan.endState.facing = "camera";
      }, 4),
    ).toContain(
      "from all fours or bent over, penetration is visible only with her back or side to the webcam: facing away or side, looking back over her shoulder",
    );
  });
});

describe("Director scene props", () => {
  const dildoHeld = {
    ...session.state,
    body: {
      ...session.state.body,
      pose: "onAllFours" as const,
      facing: "away" as const,
      hands: "holdingProp" as const,
      prop: "dildo" as const,
    },
    sceneProps: [
      {
        item: "pink silicone dildo",
        kind: "dildo" as const,
        at: "held" as const,
        where: "in her right hand, resting on the duvet beside her right hip",
      },
    ],
  };

  it("tells the Director where each toy is, from state", () => {
    const input = directorInputFor({
      state: dildoHeld,
      creator: session.creator,
      transcript: [],
      request: "again",
      speechMode: "text",
      clipSec: 10,
    });
    expect(input.now.props).toEqual(dildoHeld.sceneProps);
    // The catalogue set it down out of frame since: the entry follows body.prop.
    const setDown = directorInputFor({
      state: { ...dildoHeld, body: session.state.body },
      creator: session.creator,
      transcript: [],
      request: "again",
      speechMode: "text",
      clipSec: 10,
    });
    expect(setDown.now.props).toEqual([
      { ...dildoHeld.sceneProps[0], at: "offscreen", where: "off-screen" },
    ]);
  });

  it("persists where the Director left each prop, one per kind", () => {
    const { output } = example(4);
    const plan = directorClipPlan({
      plan: output,
      session: {
        ...session,
        state: { ...session.state, sceneProps: example(4).input.now.props },
      },
      job: reply("fuck urself with it"),
      speechMode: "text",
      durationSec: 10,
    });
    expect(plan.expectedState.sceneProps).toEqual([
      {
        item: "pink silicone dildo",
        kind: "dildo",
        at: "held",
        where: "in her right hand, resting on the duvet beside her right hip",
      },
    ]);
  });
});
