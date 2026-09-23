// LongLive has no session premise: every prompt it gets replaces the last, so each one restates the whole scene.
// A T5-conditioned video model follows short positive captions and ignores negations, so the prompt is a caption: who, one action, where.
import { isIntentSatisfied } from "../intents";
import type {
  CreatorProfile,
  GarmentId,
  IntentParser,
  LiveState,
} from "../contract";
import {
  CHECK_IN_ACTION,
  GREETING_ACTION,
  SETTLE_ACTION,
  YOUTH_WORD_RE,
  planAction,
} from "./longliveAction";
import { planBeatIntent } from "./planClip";
import { requestIntentsFor } from "./requestIntents";

const MAX_PROMPT_CHARS = 2000;
const MAX_ROOM_CHARS = 240;

// "webcam" drew floating tip stickers and app panels over the stream (A/B, same seed, only that word changed).
// Lamp and glow wording washed the frame out from 15-30 s on 2 of 6 seeds (peak glow 44% -> 0% without it).
const STYLE_LINE = "Static shot at eye level, soft even light, realistic.";
const STREAM_WORD_RE = /\b(web ?cam|live ?stream)(s?)\b/gi;
const GLOW_WORD_RE = /\s*\b(glowing|glows|glow)\b/gi;

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
  const room = surroundings
    .trim()
    .replace(STREAM_WORD_RE, "camera$2")
    .replace(GLOW_WORD_RE, "");
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
): Promise<LongLiveStep> => {
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
  return {
    prompt: buildPrompt({ creator, state, action, withWardrobe: named }),
    settlePrompt: planLongLiveSettle(creator, nextState, named),
    nextState,
    wardrobeCheck,
  };
};
