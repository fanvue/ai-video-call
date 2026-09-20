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
      job: { kind: "reply", requestId: "r1", text, channel },
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
});
