import { describe, expect, it } from "vitest";
import {
  LIVE_TUNABLES,
  type Body,
  type CreatorProfile,
  type LiveSessionSnapshot,
  type LiveState,
  type PlannedBeat,
  type Wardrobe,
} from "../contract";
import { planBeatIntent, planClip, typingLeadSecFor } from "./planClip";

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

const replyPlan = (text: string, s: LiveSessionSnapshot = session()) =>
  planClip({
    session: s,
    job: { kind: "reply", requestId: "r1", text, channel: "chat", from: "fan" },
    speechMode: "text",
  });

describe("typingLeadSecFor", () => {
  it("stays within its clamped bounds for very short and very long text", () => {
    expect(typingLeadSecFor("hi")).toBeGreaterThanOrEqual(1.5);
    expect(typingLeadSecFor("a".repeat(50))).toBeLessThanOrEqual(3.5);
  });
});

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

  it("does not invite nudity/sex on a hold, and skips CONTINUITY_LOCK even on reference backend", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "greeting" },
      speechMode: "text",
      backend: "reference",
    });
    expect(plan.prompt).not.toMatch(/render the nudity/i);
    expect(plan.prompt).not.toMatch(/CONTINUITY/);
    expect(plan.prompt).toMatch(/nothing sexual happens/i);
  });
});

describe("planClip: idle", () => {
  it("forbids pose/clothing/prop changes and stays a hold", () => {
    const plan = planClip({
      session: session(),
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.expectedState.body).toEqual(session().state.body);
    expect(plan.needsReplyText).toBe(false);
    expect(plan.durationSec).toBe(LIVE_TUNABLES.IDLE_CLIP_SEC);
    expect(plan.prompt).toMatch(/nothing sexual happens/i);
  });
});

describe("planClip: checkIn", () => {
  it("keeps state unchanged and needs reply text", () => {
    const plan = planClip({
      session: session(),
      job: { kind: "checkIn", channel: "chat" },
      speechMode: "text",
    });
    expect(plan.expectedState).toEqual(session().state);
    expect(plan.needsReplyText).toBe(true);
  });
});

describe("planClip: prompt shape", () => {
  it("never names an absent garment", () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          bra: { on: false, description: "black lace bra" },
          panties: { on: false, description: "black lace panties" },
          removedOrder: ["bra", "panties"],
        }),
      }),
    });
    const plan = replyPlan("hey", s);
    expect(plan.prompt).not.toMatch(/bra/i);
    expect(plan.prompt).not.toMatch(/panties/i);
  });

  it("has no TYPING text anywhere in a chat reply prompt", () => {
    const plan = replyPlan("take off your top");
    expect(plan.prompt).not.toMatch(/TYPING/);
  });

  it("uses the hold content line for a non-explicit reply", () => {
    const plan = replyPlan("wave hello");
    expect(plan.prompt).toMatch(/nothing sexual happens/i);
  });

  it("uses the permissive content line for an explicit reply", () => {
    const plan = replyPlan("take off your top");
    expect(plan.prompt).toMatch(/render the nudity and sexual acts/i);
  });
});

describe("planClip: reply catalog -> intents", () => {
  it('"strip" from lingerie removes bra then panties as separate beats', () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          top: { on: false, description: "tank top" },
          bottom: { on: false, description: "shorts" },
          removedOrder: ["top", "bottom"],
        }),
      }),
    });
    const plan = replyPlan("strip for me", s);
    expect(plan.expectedState.wardrobe.bra.on).toBe(false);
    expect(plan.followUps.map((b) => b.intent)).toEqual([
      { type: "removeGarment", garment: "panties" },
    ]);
  });

  it('"suck the dildo" fetches the dildo then uses it mouth-only', () => {
    const plan = replyPlan("suck the dildo");
    expect(plan.expectedState.body.prop).toBe("dildo");
    expect(plan.followUps.map((b) => b.intent)).toEqual([
      { type: "useProp", mode: "mouth" },
    ]);
  });

  it("a toy request with an external phrasing uses external contact, not mouth", () => {
    const plan = replyPlan("use the vibrator on yourself");
    expect(plan.followUps.map((b) => b.intent)).toEqual([
      { type: "useProp", mode: "external" },
    ]);
  });

  it('"take off your bra" removes only the bra', () => {
    const plan = replyPlan("take off your bra");
    expect(plan.expectedState.wardrobe.bra.on).toBe(false);
    expect(plan.expectedState.wardrobe.top.on).toBe(true);
  });

  it('"show me your tits" removes top then bra', () => {
    const plan = replyPlan("show me your tits");
    expect(plan.expectedState.wardrobe.top.on).toBe(false);
    expect(plan.followUps.map((b) => b.intent)).toEqual([
      { type: "removeGarment", garment: "bra" },
    ]);
  });

  it('"put your clothes back on" re-dresses the last removed garment', () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          top: { on: false, description: "tank top" },
          removedOrder: ["top"],
        }),
      }),
    });
    const plan = replyPlan("put your top back on", s);
    expect(plan.expectedState.wardrobe.top.on).toBe(true);
  });

  it("already-off garment resolves to a hold with an 'already' line, not a re-render", () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          bra: { on: false, description: "bra" },
          removedOrder: ["bra"],
        }),
      }),
    });
    const plan = replyPlan("take off your bra", s);
    expect(plan.prompt).toMatch(/already off/i);
    expect(plan.followUps).toEqual([]);
  });

  it("already fully nude resolves to a single hold, not four dropped beats", () => {
    const nude = wardrobe({
      top: { on: false, description: "top" },
      bottom: { on: false, description: "bottom" },
      bra: { on: false, description: "bra" },
      panties: { on: false, description: "panties" },
      removedOrder: ["top", "bottom", "bra", "panties"],
    });
    const s = session({ state: state({ wardrobe: nude }) });
    const plan = replyPlan("strip", s);
    expect(plan.followUps).toEqual([]);
    expect(plan.prompt).toMatch(/already exactly there|already/i);
  });

  it("negation on an explicit act keeps her exactly as she is", () => {
    const plan = replyPlan("don't take off your top");
    expect(plan.expectedState.wardrobe.top.on).toBe(true);
    expect(plan.prompt).toMatch(/stays exactly as she is/i);
  });

  it("garment correction ('not the top, the bottoms') targets the corrected garment", () => {
    const plan = replyPlan("not the top, the bottoms");
    expect(plan.expectedState.wardrobe.bottom.on).toBe(false);
    expect(plan.expectedState.wardrobe.top.on).toBe(true);
  });

  it("small talk and tips stay holds with no wardrobe change", () => {
    const hi = replyPlan("hey how are you");
    expect(hi.expectedState.wardrobe).toEqual(session().state.wardrobe);
    const tip = replyPlan("thanks for the tip");
    expect(tip.expectedState.wardrobe).toEqual(session().state.wardrobe);
  });

  it("an unrecognized but plainly physical request falls through to a verbatim beat", () => {
    const plan = replyPlan("do a little squat for me");
    expect(plan.expectedState.wardrobe).toEqual(session().state.wardrobe);
  });

  it("gibberish with no physical verb falls back to a friendly hold", () => {
    const plan = replyPlan("asdkjfh qwoeiu");
    expect(plan.prompt).toMatch(/friendly acknowledgement/i);
  });

  it("doggy resolves to a pose-then-grind pair, dropping the pose beat once already there", () => {
    const s = session({
      state: state({ body: body({ pose: "onAllFours", facing: "away" }) }),
    });
    const plan = replyPlan("get on all fours and grind for me", s);
    // Pose already satisfied, so the reply clip itself is the grind act, not a redundant pose hold.
    expect(plan.expectedState.body.pose).toBe("onAllFours");
    expect(plan.prompt).toMatch(/render the nudity/i);
  });

  it("come closer steps framing in one direction only", () => {
    const plan = replyPlan("come closer");
    expect(plan.expectedState.body.framing).toBe("medium");
  });

  it("back up steps framing the other way", () => {
    const s = session({ state: state({ body: body({ framing: "torso" }) }) });
    const plan = replyPlan("back up a little", s);
    expect(plan.expectedState.body.framing).toBe("medium");
  });

  it("drink fetches, sips, then rests", () => {
    const plan = replyPlan("grab a drink");
    expect(plan.expectedState.body.prop).toBe("drink");
    expect(plan.followUps.map((b) => b.intent.type)).toEqual(["hold", "rest"]);
  });

  it("touch is external contact only", () => {
    const plan = replyPlan("touch yourself");
    expect(plan.expectedState.body.contact).toBe("self");
    expect(plan.prompt).toMatch(/render the nudity/i);
  });
});

describe('planClip: reply catalog -> intents ("spin" standing precondition)', () => {
  it('"spin" while sitting plans a stand-up transition, queuing the spin as its single follow-up', () => {
    const s = session({ state: state({ body: body({ pose: "sitting" }) }) });
    const plan = replyPlan("do a spin", s);
    expect(plan.expectedState.body.pose).toBe("standing");
    expect(plan.followUps.map((b) => b.intent)).toEqual([
      { type: "act", act: "spin" },
    ]);
    expect(plan.wardrobeIntent).toBeNull();
  });

  it('"spin" while already standing plays the spin directly, ending standing with no mention of sitting', () => {
    const s = session({
      state: state({ body: body({ pose: "standing", facing: "camera" }) }),
    });
    const plan = replyPlan("do a spin", s);
    expect(plan.followUps).toEqual([]);
    expect(plan.expectedState.body.pose).toBe("standing");
    expect(plan.prompt).not.toMatch(/sitting/i);
  });
});

describe("planBeatIntent: preconditions", () => {
  it("removing panties while lying plans a stand-up clip and re-queues the original beat", () => {
    const s = state({ body: body({ pose: "lying" }) });
    const plan = planBeatIntent(
      { type: "removeGarment", garment: "panties" },
      s,
    );
    expect(plan.precondition).toEqual({
      type: "pose",
      pose: "standing",
      facing: "camera",
    });
    expect(plan.nextBody.pose).toBe("standing");
    expect(plan.nextWardrobe.panties.on).toBe(true);
  });

  it("removing the bottom while sitting needs no precondition (sitting is allowed)", () => {
    const s = state({ body: body({ pose: "sitting" }) });
    const plan = planBeatIntent(
      { type: "removeGarment", garment: "bottom" },
      s,
    );
    expect(plan.precondition).toBeUndefined();
    expect(plan.nextWardrobe.bottom.on).toBe(false);
  });

  it("removing the bra while holding a prop puts it down first", () => {
    const s = state({
      body: body({ hands: "holdingProp", prop: "vibrator" }),
    });
    const plan = planBeatIntent({ type: "removeGarment", garment: "bra" }, s);
    expect(plan.precondition).toEqual({ type: "rest" });
    expect(plan.nextBody.hands).toBe("free");
    expect(plan.nextWardrobe.bra.on).toBe(true);
  });

  it("removing the top while onAllFours stands first, same as any garment from that pose", () => {
    const s = state({ body: body({ pose: "onAllFours", facing: "away" }) });
    const plan = planBeatIntent({ type: "removeGarment", garment: "top" }, s);
    expect(plan.precondition).toEqual({
      type: "pose",
      pose: "standing",
      facing: "camera",
    });
  });
});

describe("planBeat: precondition follow-up", () => {
  it("plans the precondition clip and re-queues the ORIGINAL beat (same attempt) as its only follow-up", () => {
    const s = session({ state: state({ body: body({ pose: "lying" }) }) });
    const beat: PlannedBeat = {
      id: "b1",
      intent: { type: "removeGarment", garment: "panties" },
      attempt: 0,
    };
    const plan = planClip({
      session: s,
      job: { kind: "beat", beat },
      speechMode: "text",
    });
    expect(plan.expectedState.body.pose).toBe("standing");
    expect(plan.expectedState.wardrobe.panties.on).toBe(true);
    expect(plan.followUps).toEqual([beat]);
  });

  it("has no follow-up once the precondition is already met", () => {
    const s = session({ state: state({ body: body({ pose: "standing" }) }) });
    const beat: PlannedBeat = {
      id: "b1",
      intent: { type: "removeGarment", garment: "panties" },
      attempt: 0,
    };
    const plan = planClip({
      session: s,
      job: { kind: "beat", beat },
      speechMode: "text",
    });
    expect(plan.followUps).toEqual([]);
    expect(plan.expectedState.wardrobe.panties.on).toBe(false);
  });
});
