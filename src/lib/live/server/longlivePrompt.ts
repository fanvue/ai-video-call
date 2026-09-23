// LongLive has no session premise: every prompt it gets replaces the last, so each one restates the whole scene.
// A T5-conditioned video model follows short positive captions and ignores negations, so the prompt is a caption: who, one action, where.
import { isIntentSatisfied } from "../intents";
import type {
  BeatIntent,
  CreatorProfile,
  GarmentId,
  IntentParser,
  LiveState,
  Pose,
} from "../contract";
import { correctActionTypos } from "./actionTypos";
import {
  CHECK_IN_ACTION,
  GREETING_ACTION,
  HANDOFF_LEAD_IN_ACTION,
  MINOR_CUE_RE,
  SETTLE_ACTION,
  YOUTH_WORD_RE,
  planAction,
} from "./longliveAction";
import { planBeatIntent } from "./planClip";
import { requestIntentsFor } from "./requestIntents";

const MAX_PROMPT_CHARS = 2000;
const MAX_ROOM_CHARS = 240;

// "webcam" drew floating tip stickers and app panels over the stream (A/B, same seed, only that word changed).
const STYLE_LINE = "Static shot at eye level, warm lamp light, realistic.";
const STREAM_WORD_RE = /\b(web ?cam|live ?stream)(s?)\b/gi;

const GARMENTS: GarmentId[] = ["top", "bottom", "bra", "panties"];

export type LongLiveStep = {
  prompt: string;
  // The scene to fall back to once the action has played, so the last prompt never loops an action forever.
  settlePrompt: string;
  nextState: LiveState;
  // Garments this step changes; the client confirms them by vision on the stream before anything asserts them.
  wardrobeCheck: GarmentId[];
};

// A look that frames her as young is dropped whole; the reference frame still carries her identity.
const subjectSentence = (lookLock: string): string => {
  const look = lookLock.trim().replace(/[.\s]+$/, "");
  if (look.length === 0 || YOUTH_WORD_RE.test(look)) return "An adult woman.";
  return `An adult woman with ${look.charAt(0).toLowerCase()}${look.slice(1)}.`;
};

// Cut at a sentence end so an overlong room never pushes the action out.
const roomSentence = (surroundings: string): string => {
  // The reference capture describes any webcam framing it sees; the room keeps the camera, not the word.
  const room = surroundings.trim().replace(STREAM_WORD_RE, "camera$2");
  if (room.length <= MAX_ROOM_CHARS) return room;
  const cut = room.slice(0, MAX_ROOM_CHARS);
  const end = cut.lastIndexOf(". ");
  return end > 0 ? cut.slice(0, end + 1) : `${cut.trimEnd()}.`;
};

const wornList = (state: LiveState): string | null => {
  const worn = GARMENTS.filter((id) => state.wardrobe[id].on).map(
    (id) => `her ${state.wardrobe[id].description}`,
  );
  if (worn.length === 0) return null;
  return worn.length === 1
    ? worn[0]
    : `${worn.slice(0, -1).join(", ")} and ${worn[worn.length - 1]}`;
};

// "wearing her bra and panties", "topless, wearing only her white panties", "fully naked".
const wardrobePhrase = (state: LiveState): string => {
  const { wardrobe } = state;
  const worn = wornList(state);
  if (!worn) return "fully naked";
  const topless = !wardrobe.top.on && !wardrobe.bra.on;
  const bottomless = !wardrobe.bottom.on && !wardrobe.panties.on;
  if (topless) return `topless, wearing only ${worn}`;
  if (bottomless) return `naked from the waist down, wearing only ${worn}`;
  return `wearing ${worn}`;
};

const buildPrompt = (params: {
  creator: CreatorProfile;
  state: LiveState;
  action: string;
  // Only clothing that is on screen is named: the greeting's reference, or a change vision has confirmed.
  withWardrobe: boolean;
}): string => {
  const { creator, state, action, withWardrobe } = params;
  const subject = subjectSentence(creator.lookLock);
  return [
    withWardrobe
      ? `${subject.replace(/\.$/, "")}, ${wardrobePhrase(state)}.`
      : subject,
    action,
    roomSentence(state.surroundings),
    STYLE_LINE,
  ]
    .join(" ")
    .slice(0, MAX_PROMPT_CHARS);
};

export const planLongLiveSettle = (
  creator: CreatorProfile,
  state: LiveState,
  wardrobeObserved: boolean,
): string =>
  buildPrompt({
    creator,
    state,
    action: SETTLE_ACTION,
    withWardrobe: wardrobeObserved,
  });

const changedGarments = (before: LiveState, after: LiveState): GarmentId[] =>
  GARMENTS.filter((id) => before.wardrobe[id].on !== after.wardrobe[id].on);

export const planLongLiveGreeting = (
  creator: CreatorProfile,
  state: LiveState,
): LongLiveStep => ({
  prompt: buildPrompt({
    creator,
    state,
    action: GREETING_ACTION,
    withWardrobe: true,
  }),
  settlePrompt: planLongLiveSettle(creator, state, false),
  nextState: state,
  wardrobeCheck: [],
});

// Clip mode's planCheckIn: after a quiet stretch she looks back to the fan, and nothing about her changes.
export const planLongLiveCheckIn = (
  creator: CreatorProfile,
  state: LiveState,
  wardrobeObserved: boolean,
): LongLiveStep => ({
  prompt: buildPrompt({
    creator,
    state,
    action: CHECK_IN_ACTION,
    withWardrobe: wardrobeObserved,
  }),
  settlePrompt: planLongLiveSettle(creator, state, wardrobeObserved),
  nextState: state,
  wardrobeCheck: [],
});

// The 5B stream cannot perform these (prompt logs show the right caption, she does not move), so a swap clip plays them instead.
const CLIP_POSES: ReadonlySet<Pose> = new Set([
  "onAllFours",
  "bentOver",
  "kneeling",
  "lying",
]);
const CLIP_ACTS: ReadonlySet<Extract<BeatIntent, { type: "act" }>["act"]> =
  new Set(["spank", "doggy"]);

// Expects intents already filtered of satisfied wardrobe steps, as planLongLiveRequest does.
export const needsClipHandoff = (
  intents: BeatIntent[],
  state: LiveState,
): boolean =>
  intents.some((intent) => {
    switch (intent.type) {
      case "removeGarment":
      case "addGarment":
      case "useProp":
      case "fetchProp":
        return true;
      case "pose":
        return CLIP_POSES.has(intent.pose) && state.body.pose !== intent.pose;
      case "act":
        return CLIP_ACTS.has(intent.act);
      default:
        return false;
    }
  });

export type LongLiveRequestStep = LongLiveStep & {
  // True when a swap clip plays the action and `prompt` is only a lead-in for the stream meanwhile.
  handoff: boolean;
  // The stream's own attempt at the action, sent when there is no clip or the clip fails.
  fallbackPrompt: string;
};

export type LongLiveRequestOptions = {
  intentParser?: IntentParser;
  // True once what she wears has been seen on the stream, so prompts may name it.
  wardrobeObserved?: boolean;
};

export const planLongLiveRequest = async (
  creator: CreatorProfile,
  state: LiveState,
  requestText: string,
  options: LongLiveRequestOptions = {},
): Promise<LongLiveRequestStep> => {
  // Only wardrobe steps are dropped when already true: the pose state is a guess, so "stand up" always plays.
  const intents = (
    await requestIntentsFor(requestText, state, options.intentParser)
  ).filter(
    (intent) =>
      !(
        (intent.type === "removeGarment" || intent.type === "addGarment") &&
        isIntentSatisfied(intent, state)
      ),
  );
  let nextState = state;
  for (const intent of intents) {
    if (intent.type === "hold") continue;
    const plan = planBeatIntent(intent, nextState);
    nextState = {
      ...nextState,
      wardrobe: plan.nextWardrobe,
      body: plan.nextBody,
    };
  }
  const wardrobeCheck = changedGarments(state, nextState);
  // A change is not named until vision confirms it; unchanged clothing stays named once it has been seen.
  const named = options.wardrobeObserved === true && wardrobeCheck.length === 0;
  // Small talk and negations ("don't take it off") are never quoted: the words themselves read as a cue.
  const action = await planAction(requestText, intents, state);
  const actionPrompt = buildPrompt({
    creator,
    state,
    action,
    withWardrobe: named,
  });
  // A minor cue stays on the stream, where planAction already failed it closed to the neutral reaction.
  const handoff =
    !MINOR_CUE_RE.test(correctActionTypos(requestText)) &&
    needsClipHandoff(intents, state);
  return {
    prompt: handoff
      ? buildPrompt({
          creator,
          state,
          action: HANDOFF_LEAD_IN_ACTION,
          withWardrobe: options.wardrobeObserved === true,
        })
      : actionPrompt,
    settlePrompt: planLongLiveSettle(creator, nextState, named),
    nextState,
    wardrobeCheck,
    handoff,
    fallbackPrompt: actionPrompt,
  };
};
