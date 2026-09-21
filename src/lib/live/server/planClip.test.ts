import { describe, expect, it } from "vitest";
import {
  LIVE_TUNABLES,
  type BeatIntent,
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
    job: {
      kind: "reply",
      requestId: "r1",
      text,
      channel: "chat",
      from: "fan",
      precededByIdle: false,
    },
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

  it("adds a wardrobe-lock line to a non-wardrobe action that doesn't already carry one", () => {
    const plan = replyPlan("touch yourself");
    expect(plan.wardrobeIntent).toBeNull();
    expect(plan.prompt).toMatch(
      /Her clothing stays exactly as described .* nothing is put on or taken off\./,
    );
  });

  it("does not duplicate an existing wardrobe-lock line already in the action text", () => {
    const plan = replyPlan("wave hello");
    expect(plan.prompt).toMatch(/No clothing changes, nothing new appears\./);
    expect(plan.prompt).not.toMatch(
      /Her clothing stays exactly as described .* nothing is put on or taken off\./,
    );
  });

  it("never adds the wardrobe-lock line to a clip that actually changes wardrobe", () => {
    const plan = replyPlan("take off your top");
    expect(plan.wardrobeIntent).toBe("remove");
    expect(plan.prompt).not.toMatch(
      /Her clothing stays exactly as described .* nothing is put on or taken off\./,
    );
  });

  it("names bra/panties white in the wardrobe-lock line only when they are actually worn", () => {
    const plan = replyPlan("touch yourself");
    expect(plan.prompt).toMatch(/her bra and panties stay white/);
  });

  it("never mentions bra/panties color in the wardrobe-lock line when they're already off", () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          bra: { on: false, description: "black lace bra" },
          panties: { on: false, description: "black lace panties" },
          removedOrder: ["bra", "panties"],
        }),
      }),
    });
    const plan = replyPlan("wave hello", s);
    expect(plan.prompt).not.toMatch(/bra/i);
    expect(plan.prompt).not.toMatch(/panties/i);
  });

  it("leads a requested reply clip's prompt with the action, before the camera/anatomy locks", () => {
    const plan = replyPlan("touch yourself");
    const actionIndex = plan.prompt.indexOf("0-2s:");
    const cameraIndex = plan.prompt.indexOf("FIXED WEBCAM");
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    expect(cameraIndex).toBeGreaterThan(actionIndex);
    expect(plan.prompt).toMatch(
      /performs only this one action for the entire clip/,
    );
  });

  it("leads a beat clip's prompt with the action too", () => {
    const plan = planClip({
      session: session(),
      job: {
        kind: "beat",
        beat: { id: "b1", intent: { type: "touch" }, attempt: 0 },
      },
      speechMode: "text",
    });
    const actionIndex = plan.prompt.indexOf("0-2s:");
    const cameraIndex = plan.prompt.indexOf("FIXED WEBCAM");
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    expect(cameraIndex).toBeGreaterThan(actionIndex);
  });

  it("does not lead the idle/greeting/checkIn prompt with the action (only requested clips do)", () => {
    const plan = planClip({
      session: session(),
      job: { kind: "checkIn", channel: "chat" },
      speechMode: "text",
    });
    const cameraIndex = plan.prompt.indexOf("FIXED WEBCAM");
    expect(cameraIndex).toBe(0);
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

  it('"doggy" resolves to a single act, one clip, no separate pose beat', () => {
    const plan = replyPlan("doggy style please");
    expect(plan.followUps).toEqual([]);
    expect(plan.expectedState.body.pose).toBe("onAllFours");
    expect(plan.expectedState.body.facing).toBe("away");
    expect(plan.prompt).toMatch(/hands and knees/i);
    expect(plan.prompt).not.toMatch(/360-degree|she turns a full/i);
    expect(plan.prompt).toMatch(/render the nudity/i);
  });

  it('"spank your ass" resolves to the spank act, explicit', () => {
    const plan = replyPlan("spank your ass");
    expect(plan.followUps).toEqual([]);
    expect(plan.prompt).toMatch(/render the nudity/i);
    expect(plan.prompt).toMatch(/spanks her own ass/i);
  });

  it('"slap that ass" also resolves to the spank act', () => {
    const plan = replyPlan("slap that ass");
    expect(plan.prompt).toMatch(/spanks her own ass/i);
  });

  it('"squeeze your tits" routes to boobPlay', () => {
    const plan = replyPlan("squeeze your tits");
    expect(plan.prompt).toMatch(/cup her own breasts/i);
  });

  it('"squeeze your ass" routes to the ass-spread act instead', () => {
    const plan = replyPlan("squeeze your ass");
    expect(plan.prompt).toMatch(/pulls her ass cheeks apart/i);
  });

  it('"rub your tits" and "play with your nipples" route to boobPlay', () => {
    expect(replyPlan("rub your tits").prompt).toMatch(/cup her own breasts/i);
    expect(replyPlan("play with your nipples").prompt).toMatch(
      /cup her own breasts/i,
    );
  });

  it('"jiggle tits" resolves to the bounce act', () => {
    const plan = replyPlan("jiggle tits");
    expect(plan.followUps).toEqual([]);
    expect(plan.expectedState.body).toEqual(session().state.body);
  });

  it('"masturbate for me" resolves to touch', () => {
    const plan = replyPlan("masturbate for me");
    expect(plan.expectedState.body.contact).toBe("self");
    expect(plan.prompt).toMatch(/render the nudity/i);
  });

  it('"make yourself cum" resolves to touch', () => {
    const plan = replyPlan("make yourself cum");
    expect(plan.expectedState.body.contact).toBe("self");
  });

  it('an unknown request ("wiggle your toes") falls through to verbatim, not the friendly hold', () => {
    const plan = replyPlan("wiggle your toes");
    expect(plan.prompt).not.toMatch(/friendly acknowledgement/i);
    expect(plan.prompt).toMatch(/wiggle your toes/i);
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

  it('"suck the dildo" from standing resolves to exactly fetch-then-use, one clip, no pose/rest beats', () => {
    const s = session({
      state: state({ body: body({ pose: "standing", facing: "camera" }) }),
    });
    const plan = replyPlan("suck the dildo", s);
    expect(plan.expectedState.body.prop).toBe("dildo");
    expect(plan.followUps.map((b) => b.intent)).toEqual([
      { type: "useProp", mode: "mouth" },
    ]);
    expect(plan.wardrobeIntent).toBeNull();
  });

  it('"take your bra off" while holding a dildo sets it down in the same clip', () => {
    const s = session({
      state: state({ body: body({ hands: "holdingProp", prop: "dildo" }) }),
    });
    const plan = replyPlan("take your bra off", s);
    expect(plan.prompt).toMatch(/sets a dildo down out of frame/i);
    expect(plan.expectedState.body.prop).toBe("none");
    expect(plan.expectedState.wardrobe.bra.on).toBe(false);
    expect(plan.followUps).toEqual([]);
  });

  it('"take your panties off" while lying repositions and removes in one clip', () => {
    const s = session({ state: state({ body: body({ pose: "lying" }) }) });
    const plan = replyPlan("take your panties off", s);
    expect(plan.prompt).toMatch(/shifts to sit up/i);
    expect(plan.expectedState.wardrobe.panties.on).toBe(false);
    expect(plan.followUps).toEqual([]);
  });

  it('"dance" resolves to a single act intent', () => {
    const plan = replyPlan("dance for me");
    expect(plan.followUps).toEqual([]);
    expect(plan.expectedState.body.pose).toBe("standing");
  });
});

describe('planClip: reply catalog -> intents ("spin" one-clip lead-in)', () => {
  it('"spin" while sitting performs the rise and the spin in ONE clip, no follow-up', () => {
    const s = session({ state: state({ body: body({ pose: "sitting" }) }) });
    const plan = replyPlan("do a spin", s);
    expect(plan.prompt).toMatch(/she rises to her feet/i);
    expect(plan.expectedState.body.pose).toBe("standing");
    expect(plan.followUps).toEqual([]);
    expect(plan.wardrobeIntent).toBeNull();
  });

  it('"spin" while already standing plays the spin directly, ending standing with no mention of rising', () => {
    const s = session({
      state: state({ body: body({ pose: "standing", facing: "camera" }) }),
    });
    const plan = replyPlan("do a spin", s);
    expect(plan.followUps).toEqual([]);
    expect(plan.expectedState.body.pose).toBe("standing");
    expect(plan.prompt).not.toMatch(/rises to her feet|sitting/i);
  });
});

describe("planBeatIntent: in-clip lead-ins", () => {
  it("removing panties while lying prepends a sit-up lead-in and finishes the removal in one clip", () => {
    const s = state({ body: body({ pose: "lying" }) });
    const plan = planBeatIntent(
      { type: "removeGarment", garment: "panties" },
      s,
    );
    expect(plan.physical).toMatch(/shifts to sit up/i);
    expect(plan.nextBody.pose).toBe("sitting");
    expect(plan.nextWardrobe.panties.on).toBe(false);
  });

  it("removing the bottom while sitting needs no lead-in (sitting is allowed)", () => {
    const s = state({ body: body({ pose: "sitting" }) });
    const plan = planBeatIntent(
      { type: "removeGarment", garment: "bottom" },
      s,
    );
    expect(plan.physical).not.toMatch(/shifts to sit up|sets .* down/i);
    expect(plan.nextWardrobe.bottom.on).toBe(false);
  });

  it("removing the bra while holding a prop sets it down first, in the same clip", () => {
    const s = state({
      body: body({ hands: "holdingProp", prop: "vibrator" }),
    });
    const plan = planBeatIntent({ type: "removeGarment", garment: "bra" }, s);
    expect(plan.physical).toMatch(/sets a vibrator down out of frame/i);
    expect(plan.nextBody.hands).toBe("free");
    expect(plan.nextBody.prop).toBe("none");
    expect(plan.nextWardrobe.bra.on).toBe(false);
  });

  it("removing the top while onAllFours (not holding a prop) has no lead-in, only panties/bottom reposition", () => {
    const s = state({ body: body({ pose: "onAllFours", facing: "away" }) });
    const plan = planBeatIntent({ type: "removeGarment", garment: "top" }, s);
    expect(plan.physical).not.toMatch(/shifts to sit up|rises to her feet/i);
    expect(plan.nextWardrobe.top.on).toBe(false);
  });
});

describe("planBeat: always one clip, no follow-ups", () => {
  it("plans the whole removal (with its lead-in) in a single clip, no follow-up", () => {
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
    expect(plan.prompt).toMatch(/shifts to sit up/i);
    expect(plan.expectedState.wardrobe.panties.on).toBe(false);
    expect(plan.followUps).toEqual([]);
  });
});

describe("planClip: wardrobe change realism", () => {
  it("bra removal runs 15s with staged clasp/strap mechanics, never 'over her head'", () => {
    const plan = replyPlan("take off your bra");
    expect(plan.durationSec).toBe(LIVE_TUNABLES.MAX_CLIP_SEC);
    expect(plan.prompt).toMatch(/clasp/i);
    expect(plan.prompt).toMatch(/straps/i);
    expect(plan.prompt).not.toMatch(/over her head/i);
  });

  it("panties removal while sitting lifts her hips off the seat", () => {
    const plan = replyPlan("take off your panties");
    expect(plan.durationSec).toBe(LIVE_TUNABLES.MAX_CLIP_SEC);
    expect(plan.prompt).toMatch(/lifts her hips/i);
  });

  it("panties removal while standing steps out one foot at a time", () => {
    const s = session({
      state: state({ body: body({ pose: "standing", facing: "camera" }) }),
    });
    const plan = replyPlan("take off your panties", s);
    expect(plan.durationSec).toBe(LIVE_TUNABLES.MAX_CLIP_SEC);
    expect(plan.prompt).toMatch(/one foot/i);
  });

  it("wardrobe clips carry the fabric-physics clause", () => {
    const plan = replyPlan("take off your top");
    expect(plan.prompt).toMatch(
      /never vanishes, stretches, tears or teleports/i,
    );
  });
});

describe("planClip: pose transitions never read as a standalone spin", () => {
  it("a pose request turning to face away describes the turn as part of settling", () => {
    const plan = replyPlan("turn around");
    expect(plan.prompt).toMatch(/does not spin or turn a full circle/i);
  });
});

describe("planClip: touch (masturbation) branches on wardrobe coverage", () => {
  it("keeps the exact 'external contact only, never inserting' clause verbatim", () => {
    const plan = replyPlan("touch yourself");
    expect(plan.prompt).toMatch(/external contact only, never inserting/);
  });

  it("rubs over her panties when panties are on", () => {
    const plan = replyPlan("touch yourself");
    expect(plan.prompt).toMatch(/over her black lace panties/i);
  });

  it("rubs over bare skin once panties and bottoms are both off", () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          bottom: { on: false, description: "denim shorts" },
          panties: { on: false, description: "black lace panties" },
          removedOrder: ["bottom", "panties"],
        }),
      }),
    });
    const plan = replyPlan("touch yourself", s);
    expect(plan.prompt).toMatch(/over her bare skin/i);
  });

  it("works from standing without changing pose", () => {
    const s = session({
      state: state({ body: body({ pose: "standing", facing: "camera" }) }),
    });
    const plan = replyPlan("touch yourself", s);
    expect(plan.expectedState.body.pose).toBe("standing");
    expect(plan.prompt).toMatch(/legs slightly apart/i);
  });
});

describe("planClip: spread (legs vs ass)", () => {
  it('"spread your legs" resolves the legs variant', () => {
    const plan = replyPlan("spread your legs");
    expect(plan.followUps).toEqual([]);
    expect(plan.prompt).toMatch(/legs spread toward the lens/i);
  });

  it('"open your legs" also resolves the legs variant', () => {
    const plan = replyPlan("open your legs");
    expect(plan.prompt).toMatch(/legs spread toward the lens/i);
  });

  it('"spread your cheeks" resolves the ass variant with a lead-in from a forward-facing pose', () => {
    const plan = replyPlan("spread your cheeks");
    expect(plan.prompt).toMatch(/turns her hips away.*bends forward/i);
    expect(plan.prompt).toMatch(/pulls her ass cheeks apart/i);
    expect(plan.expectedState.body.facing).toBe("away");
  });

  it('"spread your cheeks" from onAllFours skips the lead-in', () => {
    const s = session({
      state: state({ body: body({ pose: "onAllFours", facing: "away" }) }),
    });
    const plan = replyPlan("spread your cheeks", s);
    expect(plan.prompt).not.toMatch(/turns her hips away/i);
    expect(plan.prompt).toMatch(/pulls her ass cheeks apart/i);
  });

  it('"show me your ass" resolves to the ass-spread act', () => {
    const plan = replyPlan("show me your ass");
    expect(plan.prompt).toMatch(/pulls her ass cheeks apart/i);
  });
});

const ALL_ACT_INTENTS: Extract<BeatIntent, { type: "act" }>[] = [
  { type: "act", act: "twerk" },
  { type: "act", act: "grind" },
  { type: "act", act: "bounce" },
  { type: "act", act: "spread", detail: "legs" },
  { type: "act", act: "spread", detail: "ass" },
  { type: "act", act: "sway" },
  { type: "act", act: "crawl" },
  { type: "act", act: "gesture" },
  { type: "act", act: "tongue" },
  { type: "act", act: "tease" },
  { type: "act", act: "dance" },
  { type: "act", act: "doggy" },
  { type: "act", act: "spank" },
  { type: "act", act: "boobPlay" },
];

describe("planAct purity: no incidental spins outside the spin act", () => {
  it("no non-spin act ever mentions spinning, twirling, a full turn, or 360", () => {
    const s = state();
    for (const intent of ALL_ACT_INTENTS) {
      const plan = planBeatIntent(intent, s);
      expect(plan.physical).not.toMatch(
        /\b(spins?|spinning|twirl\w*|full turn|360)\b/i,
      );
    }
  });
});

describe("planAct: every act leaves wardrobe untouched", () => {
  it.each(ALL_ACT_INTENTS)(
    "$act never mutates a dressed wardrobe",
    (intent) => {
      const w = wardrobe();
      const plan = planBeatIntent(intent, state({ wardrobe: w }));
      expect(plan.nextWardrobe).toEqual(w);
    },
  );

  it.each(ALL_ACT_INTENTS)("$act never mutates a nude wardrobe", (intent) => {
    const nude = wardrobe({
      top: { on: false, description: "top" },
      bottom: { on: false, description: "bottom" },
      bra: { on: false, description: "bra" },
      panties: { on: false, description: "panties" },
      removedOrder: ["top", "bottom", "bra", "panties"],
    });
    const plan = planBeatIntent(intent, state({ wardrobe: nude }));
    expect(plan.nextWardrobe).toEqual(nude);
  });
});

describe("planClip: compound multi-act request", () => {
  it('"spank your ass then spread your cheeks, then play with your tits" resolves to [spank, spread(ass), boobPlay] with no inserted pose/rest beats', () => {
    const plan = replyPlan(
      "spank your ass then spread your cheeks, then play with your tits",
    );
    expect(plan.prompt).toMatch(/spanks her own ass/i);
    expect(plan.followUps.map((b) => b.intent)).toEqual([
      { type: "act", act: "spread", detail: "ass" },
      { type: "act", act: "boobPlay" },
    ]);
  });
});

describe("planClip: idle variety", () => {
  it("rotates the idle life-line deterministically with elapsed time, without changing pose/clothing/props", () => {
    const prompts = [0, 1, 2, 3, 4, 5].map(
      (i) =>
        planClip({
          session: session({ elapsedSec: i * LIVE_TUNABLES.IDLE_CLIP_SEC }),
          job: { kind: "idle" },
          speechMode: "text",
        }).prompt,
    );
    // Same cadence repeats every 5 slots (the catalogue length), so slot 0 and slot 5 match.
    expect(prompts[0]).toBe(prompts[5]);
    // At least two distinct life-lines appear across a full cycle.
    expect(new Set(prompts.slice(0, 5)).size).toBeGreaterThan(1);
    for (const plan of prompts) {
      expect(plan).toMatch(/must END in the same pose/i);
    }
  });

  it("uses the phone variant instead of the rotation when she's already holding her phone", () => {
    const s = session({
      state: state({ body: body({ prop: "phone", hands: "holdingProp" }) }),
    });
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/phone already in her hand/i);
  });
});

describe("planBeatIntent: rest restores the full baseline, not just free hands", () => {
  it("restores pose/facing/framing back to baseline when they've drifted", () => {
    const baselineBody = body({ pose: "sitting", facing: "camera" });
    const s: LiveState = {
      ...state({ body: body({ pose: "onAllFours", facing: "away" }) }),
      baselineBody,
    };
    const plan = planBeatIntent({ type: "rest" }, s);
    expect(plan.nextBody).toEqual(baselineBody);
    expect(plan.physical).toMatch(/settles back into/i);
  });

  it("adds no settling line when the current pose already matches baseline", () => {
    const s = state();
    const plan = planBeatIntent({ type: "rest" }, s);
    expect(plan.nextBody).toEqual(s.baselineBody);
    expect(plan.physical).not.toMatch(/settles back into/i);
  });
});

describe("planClip: typing lead-in only after a genuine idle stretch", () => {
  const replyWithIdleFlag = (
    precededByIdle: boolean,
    channel: "chat" | "voice" = "chat",
  ) =>
    planClip({
      session: session(),
      job: {
        kind: "reply",
        requestId: "r1",
        text: "hey there",
        channel,
        from: "fan",
        precededByIdle,
      },
      speechMode: "text",
    });

  it("opens on typing when the reply follows a genuine idle stretch", () => {
    const plan = replyWithIdleFlag(true);
    expect(plan.prompt).toMatch(/types a quick reply/i);
  });

  it("does not open on typing for a fast back-to-back reply", () => {
    const plan = replyWithIdleFlag(false);
    expect(plan.prompt).not.toMatch(/types a quick reply/i);
  });

  it("does not open on typing for a voice reply even after idle", () => {
    const plan = replyWithIdleFlag(true, "voice");
    expect(plan.prompt).not.toMatch(/types a quick reply/i);
  });
});
