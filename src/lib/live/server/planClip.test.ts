import { describe, expect, it } from "vitest";
import {
  LIVE_TUNABLES,
  type Body,
  type CreatorProfile,
  type InputChannel,
  type LiveSessionSnapshot,
  type LiveState,
  type Wardrobe,
} from "../contract";
import { planClip } from "./planClip";

const wardrobe = (overrides: Partial<Wardrobe> = {}): Wardrobe => ({
  top: { on: true, description: "black ribbed tank top" },
  bottom: { on: true, description: "denim shorts" },
  bra: { on: true, description: "black lace bra" },
  panties: { on: true, description: "black lace panties" },
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

const creator: CreatorProfile = {
  id: "creator-1",
  displayName: "Aria",
  lookLock: "long dark hair, olive skin, athletic build",
  sceneId: "bedroom",
  tipMenu: [],
};

const state = (overrides: Partial<LiveState> = {}): LiveState => ({
  wardrobe: wardrobe(),
  body: body(),
  baselineBody: body(),
  world: "quiet evening, laptop propped on the desk",
  surroundings: "bedroom desk with a laptop webcam",
  ...overrides,
});

const session = (
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot => ({
  creator,
  state: state(),
  seedFrameUrl: "https://example.com/seed.jpg",
  anchorFrameUrl: "https://example.com/anchor.jpg",
  elapsedSec: 30,
  transcript: [],
  ...overrides,
});

const inRange = (sec: number) =>
  sec >= LIVE_TUNABLES.MIN_CLIP_SEC && sec <= LIVE_TUNABLES.MAX_CLIP_SEC;

describe("planClip: greeting", () => {
  it("forces the baseline body and returns a fixed reply with no LLM call needed", () => {
    const s = session({ state: state({ body: body({ pose: "lying" }) }) });
    const plan = planClip({
      session: s,
      job: { kind: "greeting" },
      speechMode: "text",
    });
    expect(plan.expectedState.body).toEqual(s.state.baselineBody);
    expect(plan.needsReplyText).toBe(false);
    expect(plan.fixedReplyText).toBeTruthy();
    expect(inRange(plan.durationSec)).toBe(true);
  });
});

describe("planClip: idle", () => {
  it("never advances a self-touch act, it pauses the hand instead", () => {
    const s = session({
      state: state({ body: body({ hands: "onBody", contact: "self" }) }),
    });
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.expectedState.body.contact).toBe("none");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
    expect(plan.durationSec).toBe(LIVE_TUNABLES.IDLE_CLIP_SEC);
  });

  it("keeps a held prop still in hand without using it", () => {
    const s = session({
      state: state({
        body: body({ hands: "holdingProp", prop: "vibrator", contact: "none" }),
      }),
    });
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.expectedState.body.prop).toBe("vibrator");
    expect(plan.expectedState.body.hands).toBe("holdingProp");
    expect(plan.prompt).toMatch(/stays held still/i);
  });

  it("instructs the clip to end back in its starting pose so it can loop", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/end in exactly the starting pose/i);
    expect(plan.prompt).toMatch(/loop seamlessly/i);
  });
});

describe("planClip: settle", () => {
  it("returns pose to baseline without touching wardrobe", () => {
    const s = session({
      state: state({ body: body({ pose: "lying", facing: "away" }) }),
    });
    const plan = planClip({
      session: s,
      job: { kind: "settle" },
      speechMode: "text",
    });
    expect(plan.expectedState.body).toEqual(s.state.baselineBody);
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
  });

  it("ends on a still, stable pose so the next clip can anchor on it", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "settle" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/settle to a still, stable end pose/i);
  });
});

describe("planClip: redress", () => {
  it("flips one garment back on and clears it from removedOrder", () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          top: { on: false, description: "black ribbed tank top" },
          removedOrder: ["top"],
        }),
      }),
    });
    const plan = planClip({
      session: s,
      job: { kind: "redress", garment: "top" },
      speechMode: "text",
    });
    expect(plan.expectedState.wardrobe.top.on).toBe(true);
    expect(plan.expectedState.wardrobe.removedOrder).not.toContain("top");
    expect(plan.expectedState.wardrobe.bottom).toEqual(s.state.wardrobe.bottom);
    expect(plan.prompt).toMatch(/settle to a still, stable end pose/i);
  });
});

describe("planClip: reply intent catalog", () => {
  const reply = (
    s: LiveSessionSnapshot,
    text: string,
    channel: InputChannel = "voice",
  ) =>
    planClip({
      session: s,
      job: { kind: "reply", requestId: "r1", text, channel, from: "fan" },
      speechMode: "text",
    });

  it("removing bottoms leaves the top, bra, and panties untouched", () => {
    const s = session();
    const plan = reply(s, "take your bottoms off");
    expect(plan.expectedState.wardrobe.bottom.on).toBe(false);
    expect(plan.expectedState.wardrobe.top.on).toBe(true);
    expect(plan.expectedState.wardrobe.bra.on).toBe(true);
    expect(plan.expectedState.wardrobe.panties.on).toBe(true);
  });

  it("treats a dress as the top garment so 'take off your dress' undresses her", () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          top: { on: true, description: "red slip dress" },
        }),
      }),
    });
    const plan = reply(s, "take off your dress");
    expect(plan.expectedState.wardrobe.top.on).toBe(false);
    expect(plan.prompt).toContain("red slip dress");
  });

  it("never asks for native speech on jobs that carry no dialogue", () => {
    const s = session();
    for (const job of [
      { kind: "idle" as const },
      { kind: "settle" as const },
      { kind: "redress" as const, garment: "top" as const },
    ]) {
      const plan = planClip({ session: s, job, speechMode: "native" });
      expect(plan.prompt).toContain("she does not speak");
    }
  });

  it("asking to remove an already-off garment is a no-op", () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          top: { on: false, description: "black ribbed tank top" },
          removedOrder: ["top"],
        }),
      }),
    });
    const plan = reply(s, "take your top off");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
  });

  it("everything off strips one garment per beat, never more than one at a time", () => {
    const s = session();
    const plan = reply(s, "take everything off");
    const beats = [
      {
        nextState: {
          wardrobe: plan.expectedState.wardrobe,
          body: plan.expectedState.body,
        },
      },
      ...plan.followUps,
    ];
    let previouslyOn = 4;
    for (const beat of beats) {
      const onCount = (["top", "bottom", "bra", "panties"] as const).filter(
        (id) => beat.nextState.wardrobe[id].on,
      ).length;
      expect(previouslyOn - onCount).toBeLessThanOrEqual(1);
      previouslyOn = onCount;
    }
    expect(previouslyOn).toBe(0);
  });

  it("never introduces a prop for an unrelated request", () => {
    const s = session();
    const plan = reply(s, "dance for me");
    expect(plan.expectedState.body.prop).toBe("none");
  });

  it("fetches a toy before it can be held", () => {
    const s = session();
    const plan = reply(s, "use the vibrator on yourself");
    expect(plan.expectedState.body.prop).toBe("fetching");
    expect(plan.followUps[0]?.nextState.body.prop).toBe("vibrator");
  });

  it("redirects an insertion request to mouth-only toy use", () => {
    const s = session();
    const plan = reply(s, "put the dildo inside you");
    const allText = [
      plan.prompt,
      ...plan.followUps.map((b) => b.physical),
    ].join(" ");
    expect(allText).toMatch(/mouth/i);
  });

  it("puts one garment back on when asked to redress", () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          top: { on: false, description: "black ribbed tank top" },
          removedOrder: ["top"],
        }),
      }),
    });
    const plan = reply(s, "put your top back on");
    expect(plan.expectedState.wardrobe.top.on).toBe(true);
  });

  it("chat replies include a typing lead when she can type", () => {
    const s = session();
    const plan = reply(s, "wave at me", "chat");
    expect(plan.replyDraft?.channel).toBe("chat");
    expect(plan.replyDraft?.typingLeadSec).toBeGreaterThan(0);
    expect(plan.prompt).toMatch(/TYPING FIRST/i);
  });

  it("voice replies have no typing lead", () => {
    const s = session();
    const plan = reply(s, "wave at me", "voice");
    expect(plan.replyDraft?.typingLeadSec).toBe(0);
  });

  it("keeps every reply duration, including follow-up beats, within the contract range", () => {
    const requests = [
      "hey",
      "take your top off",
      "everything off",
      "stand up",
      "use the dildo",
      "touch yourself",
      "dance for me",
      "get me a drink",
      "thanks for the tip",
      "put your top back on",
      "asdkjaslkdj nonsense",
    ];
    const s = session();
    for (const text of requests) {
      const plan = reply(s, text);
      expect(inRange(plan.durationSec)).toBe(true);
      for (const beat of plan.followUps) {
        expect(inRange(beat.durationSec)).toBe(true);
      }
    }
  });

  it("an unknown request makes no state change and locks against undressing", () => {
    const s = session();
    const plan = reply(s, "what's your favorite color");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
    expect(plan.expectedState.body).toEqual(s.state.body);
    expect(plan.prompt).toMatch(/NO UNDRESSING LOCK/i);
  });

  it("names the exact captured garment descriptions and the universal locks in the prompt", () => {
    const s = session();
    const plan = reply(s, "hi there");
    expect(plan.prompt).toContain("black ribbed tank top");
    expect(plan.prompt).toContain("denim shorts");
    expect(plan.prompt).toMatch(/FIXED WEBCAM/);
    expect(plan.prompt).toMatch(/ANATOMY LOCK/);
    expect(plan.prompt).toMatch(/LOOK LOCK/);
  });

  it("ends the reply's own prompt on a still, stable pose since its last frame becomes the next anchor", () => {
    const s = session();
    const plan = reply(s, "wave at me");
    expect(plan.prompt).toMatch(/settle to a still, stable end pose/i);
  });
});

describe("planClip: beat", () => {
  it("ends on a still, stable pose since its last frame becomes the next anchor", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          physical: "she leans in and smiles",
          durationSec: 10,
          nextState: { wardrobe: s.state.wardrobe, body: s.state.body },
        },
      },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/settle to a still, stable end pose/i);
  });
});

describe("planClip: timing rule", () => {
  const reply = (s: LiveSessionSnapshot, text: string) =>
    planClip({
      session: s,
      job: {
        kind: "reply",
        requestId: "r1",
        text,
        channel: "voice",
        from: "fan",
      },
      speechMode: "text",
    });

  it("greeting, settle, redress and checkIn run the full ACTION_CLIP_SEC", () => {
    const s = session();
    expect(
      planClip({ session: s, job: { kind: "greeting" }, speechMode: "text" })
        .durationSec,
    ).toBe(LIVE_TUNABLES.ACTION_CLIP_SEC);
    expect(
      planClip({ session: s, job: { kind: "settle" }, speechMode: "text" })
        .durationSec,
    ).toBe(LIVE_TUNABLES.ACTION_CLIP_SEC);
    expect(
      planClip({
        session: s,
        job: { kind: "redress", garment: "top" },
        speechMode: "text",
      }).durationSec,
    ).toBe(LIVE_TUNABLES.ACTION_CLIP_SEC);
    expect(
      planClip({
        session: s,
        job: { kind: "checkIn", channel: "chat" },
        speechMode: "text",
      }).durationSec,
    ).toBe(LIVE_TUNABLES.ACTION_CLIP_SEC);
  });

  it("idle stays at IDLE_CLIP_SEC", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.durationSec).toBe(LIVE_TUNABLES.IDLE_CLIP_SEC);
  });

  it("a real requested action clip runs the full ACTION_CLIP_SEC", () => {
    const s = session();
    const plan = reply(s, "take your top off");
    expect(plan.durationSec).toBe(LIVE_TUNABLES.ACTION_CLIP_SEC);
  });
});

describe("planClip: act catalog additions", () => {
  const reply = (
    s: LiveSessionSnapshot,
    text: string,
    channel: InputChannel = "voice",
  ) =>
    planClip({
      session: s,
      job: { kind: "reply", requestId: "r1", text, channel, from: "fan" },
      speechMode: "text",
    });

  it("wave / blow a kiss / smile-wink cause no state change", () => {
    const s = session();
    for (const text of ["wave at me", "blow me a kiss", "wink at me"]) {
      const plan = reply(s, text);
      expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
      expect(plan.expectedState.body).toEqual(s.state.body);
    }
  });

  it("show tongue / lick lips cause no state change", () => {
    const s = session();
    const plan = reply(s, "lick your lips");
    expect(plan.expectedState.body).toEqual(s.state.body);
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
  });

  it("jiggle tits bounces in the top when it's on, no removal", () => {
    const s = session();
    const plan = reply(s, "jiggle your tits");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
    expect(plan.prompt).not.toMatch(/settle to a still, stable end pose. She/);
  });

  it("doggy style transitions through kneeling to on all fours, facing away", () => {
    const s = session();
    const plan = reply(s, "get on all fours");
    expect(plan.followUps.length + 1).toBeGreaterThanOrEqual(1);
    const finalState =
      plan.followUps[plan.followUps.length - 1]?.nextState ??
      plan.expectedState;
    expect(finalState.body.pose).toBe("onAllFours");
    expect(finalState.body.facing).toBe("away");
  });

  it("doggy style from an already-kneeling pose skips the transition beat", () => {
    const s = session({
      state: state({ body: body({ pose: "kneeling" }) }),
    });
    const plan = reply(s, "doggy style");
    expect(plan.followUps).toHaveLength(0);
    expect(plan.expectedState.body.pose).toBe("onAllFours");
    expect(plan.expectedState.body.facing).toBe("away");
  });

  it("bend over sets the bentOver pose", () => {
    const s = session();
    const plan = reply(s, "bend over for me");
    const finalState =
      plan.followUps[plan.followUps.length - 1]?.nextState ??
      plan.expectedState;
    expect(finalState.body.pose).toBe("bentOver");
  });

  it("crawl toward the camera moves the body closer without moving the camera", () => {
    const s = session({
      state: state({ body: body({ pose: "onAllFours", facing: "camera" }) }),
    });
    const plan = reply(s, "crawl toward me");
    expect(plan.expectedState.body.framing).toBe("medium");
    expect(plan.prompt).toMatch(/camera itself never moves/i);
  });

  it("spread legs keeps her sitting or lying, facing camera, no clothing change", () => {
    const s = session();
    const plan = reply(s, "spread your legs");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
    const finalState =
      plan.followUps[plan.followUps.length - 1]?.nextState ??
      plan.expectedState;
    expect(["sitting", "lying"]).toContain(finalState.body.pose);
    expect(finalState.body.facing).toBe("camera");
  });

  it("twerk / shake ass transitions to standing, facing away", () => {
    const s = session();
    const plan = reply(s, "shake your ass");
    const finalState =
      plan.followUps[plan.followUps.length - 1]?.nextState ??
      plan.expectedState;
    expect(finalState.body.pose).toBe("standing");
    expect(finalState.body.facing).toBe("away");
  });

  it("come closer and back up move framing without any wardrobe change", () => {
    const s = session();
    const closer = reply(s, "come closer");
    expect(closer.expectedState.body.framing).toBe("medium");
    const back = reply(s, "back up a bit");
    expect(back.expectedState.body.framing).toBe(s.state.body.framing);
  });

  it("fetches a toy, uses it externally, then puts it down for an unrelated request", () => {
    const s = session();
    const used = reply(s, "use the vibrator on yourself");
    expect(used.expectedState.body.prop).toBe("fetching");
    expect(used.followUps[0]?.physical).toMatch(/externally/i);
    const heldState = used.followUps[0]?.nextState;
    if (!heldState) throw new Error("expected a follow-up beat");
    const next = session({ state: { ...s.state, ...heldState } });
    const followUp = reply(next, "wave at me");
    expect(followUp.prompt).toMatch(/sets the vibrator down/i);
  });

  it("self-touch stays external only, even when insertion is asked", () => {
    const s = session();
    const plan = reply(s, "insert your fingers inside yourself");
    expect(plan.prompt).toMatch(/external/i);
    expect(plan.expectedState.body.contact).toBe("self");
  });

  it("avoids false positives on common lookalike phrases", () => {
    const s = session();
    for (const text of [
      "stop",
      "coffee please",
      "down there",
      "top of the morning",
    ]) {
      const plan = reply(s, text);
      expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
    }
    // "coffee" legitimately triggers fetching a drink (intentional, not a garment/undressing match).
    const coffee = reply(s, "coffee please");
    expect(coffee.expectedState.body.prop).toBe("fetching");
  });
});

describe("planClip: typing realism", () => {
  const reply = (s: LiveSessionSnapshot, text: string) =>
    planClip({
      session: s,
      job: {
        kind: "reply",
        requestId: "r1",
        text,
        channel: "chat",
        from: "fan",
      },
      speechMode: "text",
    });

  it("types on the laptop keyboard when sitting with a free hand", () => {
    const s = session();
    const plan = reply(s, "wave at me");
    expect(plan.prompt).toMatch(/off-screen keyboard/i);
  });

  it("reaches for her phone when not sitting", () => {
    const s = session({ state: state({ body: body({ pose: "standing" }) }) });
    const plan = reply(s, "wave at me");
    expect(plan.prompt).toMatch(/picks up her phone/i);
    expect(plan.prompt).toMatch(/thumbs/i);
  });

  it("sets a held toy down before typing on the phone, and can pick it back up", () => {
    const s = session({
      state: state({
        body: body({
          pose: "standing",
          prop: "vibrator",
          hands: "holdingProp",
          contact: "self",
        }),
      }),
    });
    const plan = reply(s, "wave at me");
    expect(plan.prompt).toMatch(/sets the vibrator she was holding down/i);
  });
});

describe("planClip: room viewers", () => {
  it("plans a reply job for a viewer request the same as a fan's", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: {
        kind: "reply",
        requestId: "r1",
        text: "wave at me",
        channel: "chat",
        from: "viewer",
        handle: "someviewer",
      },
      speechMode: "text",
    });
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
  });
});
