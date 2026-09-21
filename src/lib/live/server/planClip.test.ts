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
  anchorHasBody: true,
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

describe("planClip: greeting", () => {
  it("does not invite nudity/sex on a hold, and skips CONTINUITY_LOCK even on reference backend", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "greeting" },
      speechMode: "text",
      backend: "reference",
    });
    expect(plan.prompt).not.toMatch(/render them directly and fully/i);
    expect(plan.prompt).not.toMatch(
      /is only a face\/identity likeness reference/i,
    );
  });

  it("describes the wardrobe explicitly instead of pointing at the seed frame when the reference photo has no visible body", () => {
    const s = session({
      seedFrameUrl: "https://example.com/anchor.jpg",
      anchorFrameUrl: "https://example.com/anchor.jpg",
      anchorHasBody: false,
    });
    const plan = planClip({
      session: s,
      job: { kind: "greeting" },
      speechMode: "text",
    });
    expect(plan.prompt).not.toMatch(/pixel-for-pixel from the seed frame/i);
    expect(plan.prompt).toMatch(/no clothing pixels in it to copy/i);
  });

  it("still copies from the seed frame once the seed is a real generated frame, even with a bodyless anchor", () => {
    const s = session({
      seedFrameUrl: "https://example.com/extracted.jpg",
      anchorFrameUrl: "https://example.com/anchor.jpg",
      anchorHasBody: false,
    });
    const plan = planClip({
      session: s,
      job: { kind: "greeting" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/pixel-for-pixel from the seed frame/i);
  });
});

describe("planClip: idle", () => {
  it("does not invite nudity/sex on a hold", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.prompt).not.toMatch(/render them directly and fully/i);
  });

  it("locks garments that are currently on to stay on, not just garments that are off", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/pixel-for-pixel from the seed frame/i);
  });

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

  it("instructs the clip to end back in its starting pose, with no pose-category switching", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/must end in the same pose/i);
    expect(plan.prompt).toMatch(/no change of pose category/i);
    expect(plan.prompt).toMatch(
      /she never sits, stands, kneels, or lies down/i,
    );
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

  it("tells the model the prior act is over so it doesn't just keep rendering it from the seed frame", () => {
    const s = session({
      state: state({
        body: body({
          pose: "onAllFours",
          facing: "away",
          contact: "self",
        }),
      }),
    });
    const plan = planClip({
      session: s,
      job: { kind: "settle" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(
      /SCENE CHANGE: whatever she was doing before this clip is now over and does not continue, repeat, or restart/i,
    );
  });

  it("timecodes the rise when a big pose delta needs it, instead of one vague sentence", () => {
    const s = session({
      state: state({ body: body({ pose: "lying", facing: "away" }) }),
    });
    const plan = planClip({
      session: s,
      job: { kind: "settle" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/0-3s:.*3-11s:/i);
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

  it("plays a spin on the bare word 'spin', not just 'spin around' or 'do a spin'", () => {
    const s = session();
    const plan = reply(s, "can you spin for me");
    expect(plan.prompt).toMatch(/360-degree/i);
  });

  it("a spin is timecoded and restates every untouched garment right beside the turn instruction, not just in the general lock block", () => {
    const s = session();
    const plan = reply(s, "can you spin for me");
    expect(plan.prompt).toMatch(/0-2s:.*2-6s:.*6-8s:/i);
    expect(plan.prompt).toMatch(
      /WARDROBE FREEZE for the action below: copy her top \(.*\) pixel-for-pixel from the seed frame; copy her bottoms \(.*\) pixel-for-pixel from the seed frame; copy her bra \(.*\) pixel-for-pixel from the seed frame; copy her panties \(.*\) pixel-for-pixel from the seed frame/i,
    );
  });

  it("the wardrobe freeze never claims a garment is copied unchanged when this clip's own instruction removes it", () => {
    const s = session();
    const plan = reply(s, "take your top off");
    const reminder = plan.prompt.match(
      /WARDROBE FREEZE for the action below:[^.]*\./i,
    )?.[0];
    expect(reminder).toBeDefined();
    expect(reminder).not.toMatch(/her top \(/i);
    expect(reminder).toMatch(/copy her bottoms \(.*\) pixel-for-pixel/i);
  });

  it("removing a top warns the model not to let the adjacent bra flicker, since it's redrawing that area anyway", () => {
    const s = session();
    const plan = reply(s, "take your top off");
    expect(plan.prompt).toMatch(
      /never touches, loosens, or hides any of these — not even for a single frame, even though the action happens right beside them/i,
    );
  });

  it("a pure hold with nothing changing gets no collision-guard sentence, since nothing is being removed to collide with", () => {
    const s = session();
    const plan = reply(s, "hey how are you");
    expect(plan.prompt).not.toMatch(/right beside them/i);
  });

  it("'show me your tits' removes the top and bra across this clip and its follow-up, instead of falling through to a no-clothing-change generic action", () => {
    const s = session();
    const plan = reply(s, "show me your tits");
    expect(plan.expectedState.wardrobe.bottom.on).toBe(true);
    expect(plan.prompt).not.toMatch(
      /no garment is added, removed, or shifted/i,
    );
    const finalWardrobe =
      plan.followUps[plan.followUps.length - 1]?.nextState.wardrobe ??
      plan.expectedState.wardrobe;
    expect(finalWardrobe.top.on).toBe(false);
    expect(finalWardrobe.bra.on).toBe(false);
  });

  it("'show me your pussy' removes bottoms and panties across this clip and its follow-up, leaving top and bra untouched", () => {
    const s = session();
    const plan = reply(s, "let me see your pussy");
    expect(plan.expectedState.wardrobe.top.on).toBe(true);
    expect(plan.expectedState.wardrobe.bra.on).toBe(true);
    const finalWardrobe =
      plan.followUps[plan.followUps.length - 1]?.nextState.wardrobe ??
      plan.expectedState.wardrobe;
    expect(finalWardrobe.bottom.on).toBe(false);
    expect(finalWardrobe.panties.on).toBe(false);
  });

  it("'show me your tits' when already bare is a no-op, not a repeat removal", () => {
    const s = session({
      state: state({
        wardrobe: wardrobe({
          top: { on: false, description: "black ribbed tank top" },
          bra: { on: false, description: "black lace bra" },
          removedOrder: ["top", "bra"],
        }),
      }),
    });
    const plan = reply(s, "show me your tits");
    expect(plan.expectedState.wardrobe.top.on).toBe(false);
    expect(plan.expectedState.wardrobe.bra.on).toBe(false);
    expect(plan.prompt).toMatch(/already showing/i);
  });

  it("invites nudity/sex content only on a beat that actually removes clothing", () => {
    const s = session();
    const stripPlan = reply(s, "take your bottoms off");
    expect(stripPlan.prompt).toMatch(/render them directly and fully/i);
    const talkPlan = reply(s, "what's your favorite color");
    expect(talkPlan.prompt).not.toMatch(/render them directly and fully/i);
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

  it("'suck a dildo' uses it in her mouth, not the default external-against-skin line", () => {
    const s = session();
    const plan = reply(s, "suck the dildo");
    const allText = [
      plan.prompt,
      ...plan.followUps.map((b) => b.physical),
    ].join(" ");
    expect(allText).toMatch(/mouth/i);
    expect(allText).not.toMatch(/against her skin/i);
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

  it("an explicit follow-up beat (e.g. doggy's grinding motion) gets the permissive content lock, not the hold lock that would contradict its own instruction", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          physical: "she rocks and grinds her hips toward the webcam",
          durationSec: 11,
          nextState: { wardrobe: s.state.wardrobe, body: s.state.body },
          explicit: true,
        },
      },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/render them directly and fully/i);
    expect(plan.prompt).not.toMatch(/nothing sexual or nudity-changing/i);
  });

  it("a non-explicit follow-up beat with no wardrobe/contact change still gets the hold lock", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          physical: "she waves",
          durationSec: 11,
          nextState: { wardrobe: s.state.wardrobe, body: s.state.body },
        },
      },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(/nothing sexual or nudity-changing/i);
    expect(plan.prompt).not.toMatch(/authorized fictional adult content/i);
    expect(plan.prompt).toMatch(/do not add nudity, undressing/i);
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

  it("doggy style from an already-kneeling pose skips the transition beat but keeps the continuing motion", () => {
    const s = session({
      state: state({ body: body({ pose: "kneeling" }) }),
    });
    const plan = reply(s, "doggy style");
    expect(plan.followUps).toHaveLength(1);
    const finalState =
      plan.followUps[plan.followUps.length - 1]?.nextState ??
      plan.expectedState;
    expect(finalState.body.pose).toBe("onAllFours");
    expect(finalState.body.facing).toBe("away");
  });

  it("doggy style's grinding beat gets the permissive content lock, not the plain-hold lock that would contradict its own instruction", () => {
    const s = session({
      state: state({ body: body({ pose: "kneeling" }) }),
    });
    const plan = reply(s, "doggy style");
    const grindBeat = plan.followUps[plan.followUps.length - 1];
    expect(grindBeat?.explicit).toBe(true);
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

describe("planClip: negation", () => {
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

  it("a negated undress request makes no state change and locks against undressing", () => {
    const s = session();
    const plan = reply(s, "don't take your top off");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
    expect(plan.prompt).toMatch(/NO UNDRESSING LOCK/i);
  });

  it("negates a bare strip verb without the apostrophe", () => {
    const s = session();
    const plan = reply(s, "dont strip");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
  });

  it("negates a toy request, never advancing the prop to fetching", () => {
    const s = session();
    const plan = reply(s, "no toys please");
    expect(plan.expectedState.body.prop).toBe("none");
  });

  it("a request with no removal verb never undresses regardless of wording", () => {
    const s = session();
    const plan = reply(s, "keep your clothes on");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
  });

  it("mentioning an outfit alongside an unrelated 'down'/'off' never undresses her", () => {
    const s = session();
    expect(reply(s, "nice outfit, sit down").expectedState.wardrobe).toEqual(
      s.state.wardrobe,
    );
    expect(
      reply(s, "love that outfit, calm down").expectedState.wardrobe,
    ).toEqual(s.state.wardrobe);
    expect(
      reply(s, "your outfit is off the charts").expectedState.wardrobe,
    ).toEqual(s.state.wardrobe);
  });

  it("a cancelled request followed by an unmatched clause makes no state change", () => {
    const s = session();
    const plan = reply(s, "never mind, stay sitting");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
    expect(plan.expectedState.body).toEqual(s.state.body);
  });

  it("'no way' is an intensifier, not a negation, so the strip still happens", () => {
    const s = session();
    const plan = reply(s, "no way, take it off");
    expect(plan.expectedState.wardrobe.top.on).toBe(false);
  });

  it("a garment correction strips the corrected garment, not the negated one", () => {
    const s = session();
    const plan = reply(s, "not the top, the bottoms");
    expect(plan.expectedState.wardrobe.bottom.on).toBe(false);
    expect(plan.expectedState.wardrobe.top.on).toBe(true);
  });

  it("a filler word ('stop'/'no') beside an unrelated request, with no comma, still performs it", () => {
    const s = session();
    expect(reply(s, "stop and spin around").prompt).toMatch(/360-degree/i);
    expect(reply(s, "no wait spin around").prompt).toMatch(/360-degree/i);
  });
});

describe("planClip: multi-act requests", () => {
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

  it("splits on 'then' and resolves each clause in order", () => {
    const s = session();
    const plan = reply(s, "take ur top off then shake ur ass");
    expect(plan.expectedState.wardrobe.top.on).toBe(false);
    const finalState =
      plan.followUps[plan.followUps.length - 1]?.nextState ??
      plan.expectedState;
    expect(finalState.body.pose).toBe("standing");
    expect(finalState.body.facing).toBe("away");
  });

  it("splits on a bare 'and' only when both halves independently match an act", () => {
    const s = session();
    const plan = reply(s, "take off your top and dance for me");
    expect(plan.expectedState.wardrobe.top.on).toBe(false);
    const finalState =
      plan.followUps[plan.followUps.length - 1]?.nextState ??
      plan.expectedState;
    expect(finalState.body.pose).toBe("standing");
  });

  it("keeps 'bra and panties' as one clause instead of splitting mid-garment-list", () => {
    const s = session();
    const plan = reply(s, "take off your bra and panties");
    expect(plan.expectedState.wardrobe.bra.on).toBe(false);
    expect(plan.expectedState.wardrobe.panties.on).toBe(true);
  });

  it("dedupes consecutive identical beats", () => {
    const s = session();
    const plan = reply(s, "wave at me then wave at me");
    expect(plan.followUps).toHaveLength(0);
  });

  it("caps the total beat sequence at the contract's follow-up limit", () => {
    const s = session();
    const plan = reply(
      s,
      "wave at me then blow me a kiss then wink at me then lick your lips " +
        "then stick out your tongue then jiggle your tits then thanks for the tip then good morning",
    );
    expect(plan.followUps.length).toBeLessThanOrEqual(6);
    for (const beat of plan.followUps) {
      expect(inRange(beat.durationSec)).toBe(true);
    }
  });
});

describe("planClip: catalog gaps", () => {
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

  const finalGarmentCount = (plan: ReturnType<typeof reply>) => {
    const beats = [
      { nextState: { wardrobe: plan.expectedState.wardrobe } },
      ...plan.followUps,
    ];
    const last = beats[beats.length - 1]?.nextState.wardrobe;
    return (["top", "bottom", "bra", "panties"] as const).filter(
      (id) => last?.[id].on,
    ).length;
  };

  it.each(["strip", "strip for me", "get naked"])(
    "%s strips everything, one garment per beat",
    (text) => {
      const s = session();
      const plan = reply(s, text);
      expect(finalGarmentCount(plan)).toBe(0);
    },
  );

  it.each(["shake that ass", "shake it", "twerk for me", "booty"])(
    "%s turns her to a standing twerk facing away",
    (text) => {
      const s = session();
      const plan = reply(s, text);
      const finalState =
        plan.followUps[plan.followUps.length - 1]?.nextState ??
        plan.expectedState;
      expect(finalState.body.pose).toBe("standing");
      expect(finalState.body.facing).toBe("away");
    },
  );

  it("still passes the existing false-positive phrases", () => {
    const s = session();
    for (const text of [
      "stop",
      "coffee please",
      "down there",
      "top of the morning",
      "that top is so cute, calm down",
      "nice bra, sit back down please",
    ]) {
      const plan = reply(s, text);
      expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
    }
  });

  it.each([
    "take your top off",
    "remove your bra",
    "slide your panties off",
    "pull down your bottoms",
    "u should get naked",
    "get nude",
    "everything off pls",
    "take it all off",
    "nothing on",
    "strip everything",
    "dance for me",
    "twerk",
    "shake ur booty",
    "get on all fours",
    "doggy",
    "bend over",
    "crawl to the camera",
    "spread your legs",
    "come closer",
    "back up a bit",
    "use the dildo",
    "vibe on yourself",
    "touch urself",
    "finger yourself",
    "get me a drink",
    "coffee please",
    "wave hello",
    "blow a kiss",
    "wink at me",
    "thx for the tip",
  ])("resolves '%s' to a valid in-range clip plan", (text) => {
    const s = session();
    const plan = reply(s, text);
    expect(inRange(plan.durationSec)).toBe(true);
    for (const beat of plan.followUps) {
      expect(inRange(beat.durationSec)).toBe(true);
    }
  });
});

describe("planClip: single-clip replies (finding 4)", () => {
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

  it("folds a real action into the reply clip instead of costing two clips", () => {
    const s = session();
    const plan = reply(s, "take your top off");
    expect(plan.expectedState.wardrobe.top.on).toBe(false);
    expect(plan.durationSec).toBe(LIVE_TUNABLES.MAX_CLIP_SEC);
    expect(plan.prompt).toMatch(/TYPING FIRST/i);
    expect(plan.prompt).toMatch(/Then, for the rest of the clip/i);
    expect(plan.replyDraft?.typingLeadSec).toBeLessThanOrEqual(
      plan.durationSec,
    );
  });

  it("keeps a pure typing-only clip for small talk, the beat becomes a follow-up", () => {
    const s = session();
    const plan = reply(s, "wave at me");
    expect(plan.expectedState.wardrobe).toEqual(s.state.wardrobe);
    expect(plan.expectedState.body).toEqual(s.state.body);
    expect(plan.followUps.length).toBeGreaterThanOrEqual(1);
    expect(plan.followUps[0]?.physical).toMatch(/wave/i);
  });

  it("keeps a pure typing-only clip when the first beat is a fetch", () => {
    const s = session();
    const plan = reply(s, "use the vibrator on yourself");
    expect(plan.expectedState.body.prop).toBe("none");
    expect(plan.followUps[0]?.nextState.body.prop).toBe("fetching");
    expect(plan.followUps[1]?.nextState.body.prop).toBe("vibrator");
  });

  it("never lets the typing lead exceed the clip duration", () => {
    const s = session();
    for (const text of [
      "hi",
      "take your top off",
      "everything off",
      "dance for me",
    ]) {
      const plan = reply(s, text);
      expect(plan.replyDraft?.typingLeadSec ?? 0).toBeLessThanOrEqual(
        plan.durationSec,
      );
    }
  });
});

describe("planClip: phone typing vs prop lock (finding 9)", () => {
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

  it("permits the phone in the prop lock instead of contradicting the typing action", () => {
    const s = session({ state: state({ body: body({ pose: "standing" }) }) });
    const plan = reply(s, "wave at me");
    expect(plan.prompt).toMatch(/picks up her phone/i);
    expect(plan.prompt).toMatch(
      /PROP LOCK: the only object in frame is her phone/i,
    );
    expect(plan.prompt).not.toMatch(/hands are empty/i);
  });

  it("still narrates setting down a held prop before picking up the phone", () => {
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
    expect(plan.prompt).toMatch(
      /PROP LOCK: the only object in frame is her phone/i,
    );
  });

  it("does not touch the committed prop state, only the clip's lock text", () => {
    const s = session({ state: state({ body: body({ pose: "standing" }) }) });
    const plan = reply(s, "wave at me");
    expect(plan.expectedState.body.prop).toBe("none");
  });
});

describe("planClip: settle prop vanish (finding 5)", () => {
  it("narrates putting the exact object down before settling on a same-level pose transition", () => {
    const s = session({
      state: state({
        body: body({
          pose: "sitting",
          prop: "vibrator",
          hands: "holdingProp",
          contact: "self",
        }),
        baselineBody: body({ pose: "sitting" }),
      }),
    });
    const plan = planClip({
      session: s,
      job: { kind: "settle" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(
      /sets the vibrator down, out of frame but within reach, before settling/i,
    );
  });

  it("still narrates putting the object down on a big pose delta (lying)", () => {
    const s = session({
      state: state({
        body: body({
          pose: "lying",
          prop: "dildo",
          hands: "holdingProp",
          contact: "self",
        }),
        baselineBody: body({ pose: "sitting" }),
      }),
    });
    const plan = planClip({
      session: s,
      job: { kind: "settle" },
      speechMode: "text",
    });
    expect(plan.prompt).toMatch(
      /sets the dildo down, out of frame but within reach, before settling/i,
    );
  });

  it("says nothing about a prop when she isn't holding one", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "settle" },
      speechMode: "text",
    });
    expect(plan.prompt).not.toMatch(/out of frame but within reach/i);
  });
});

describe("planClip backend prompt", () => {
  it("adds a continuity lock against the reference image for the reference backend", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
      backend: "reference",
    });
    expect(plan.prompt).toMatch(/CONTINUITY:/);
    expect(plan.prompt.indexOf("CONTINUITY:")).toBe(0);
  });

  it("omits the continuity lock for the turbo backend, which anchors on a literal starting frame", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
      backend: "turbo",
    });
    expect(plan.prompt).not.toMatch(/CONTINUITY:/);
  });

  it("defaults to no continuity lock when backend is omitted", () => {
    const s = session();
    const plan = planClip({
      session: s,
      job: { kind: "idle" },
      speechMode: "text",
    });
    expect(plan.prompt).not.toMatch(/CONTINUITY:/);
  });
});
