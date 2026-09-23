// LongLive has no session premise: every prompt it gets replaces the last, so each one restates the whole scene.
// A T5-conditioned video model follows short positive captions and ignores negations, so the prompt is a caption: who, one action, where.
import { isIntentSatisfied } from "../intents";
import type { CreatorProfile, LiveState } from "../contract";
import {
  GREETING_ACTION,
  SETTLE_ACTION,
  YOUTH_WORD_RE,
  planAction,
} from "./longliveAction";
import { planBeatIntent, resolveIntents } from "./planClip";

const MAX_PROMPT_CHARS = 2000;
const MAX_ROOM_CHARS = 240;

const STYLE_LINE =
  "Static webcam shot at eye level, warm lamp light, realistic.";

export type LongLiveStep = {
  prompt: string;
  // The scene to fall back to once the action has played, so the last prompt never loops an action forever.
  settlePrompt: string;
  nextState: LiveState;
};

// A look that frames her as young is dropped whole; the reference frame still carries her identity.
const subjectSentence = (lookLock: string): string => {
  const look = lookLock.trim().replace(/[.\s]+$/, "");
  if (look.length === 0 || YOUTH_WORD_RE.test(look)) return "An adult woman.";
  return `An adult woman with ${look.charAt(0).toLowerCase()}${look.slice(1)}.`;
};

// Cut at a sentence end so an overlong room never pushes the action out.
const roomSentence = (surroundings: string): string => {
  const room = surroundings.trim();
  if (room.length <= MAX_ROOM_CHARS) return room;
  const cut = room.slice(0, MAX_ROOM_CHARS);
  const end = cut.lastIndexOf(". ");
  return end > 0 ? cut.slice(0, end + 1) : `${cut.trimEnd()}.`;
};

const wornList = (state: LiveState): string | null => {
  const worn = (["top", "bottom", "bra", "panties"] as const)
    .filter((id) => state.wardrobe[id].on)
    .map((id) => `her ${state.wardrobe[id].description}`);
  if (worn.length === 0) return null;
  return worn.length === 1
    ? worn[0]
    : `${worn.slice(0, -1).join(", ")} and ${worn[worn.length - 1]}`;
};

const buildPrompt = (params: {
  creator: CreatorProfile;
  state: LiveState;
  action: string;
  // Only the greeting names her clothes; later prompts leave the frames to carry them.
  withWardrobe: boolean;
}): string => {
  const { creator, state, action, withWardrobe } = params;
  const worn = withWardrobe ? wornList(state) : null;
  const subject = subjectSentence(creator.lookLock);
  return [
    worn ? `${subject.replace(/\.$/, "")}, wearing ${worn}.` : subject,
    action,
    roomSentence(state.surroundings),
    STYLE_LINE,
  ]
    .join(" ")
    .slice(0, MAX_PROMPT_CHARS);
};

const settleFor = (creator: CreatorProfile, state: LiveState): string =>
  buildPrompt({ creator, state, action: SETTLE_ACTION, withWardrobe: false });

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
  settlePrompt: settleFor(creator, state),
  nextState: state,
});

export const planLongLiveRequest = async (
  creator: CreatorProfile,
  state: LiveState,
  requestText: string,
): Promise<LongLiveStep> => {
  // Only wardrobe steps are dropped when already true: the pose state is a guess, so "stand up" always plays.
  const intents = resolveIntents(
    requestText,
    state.wardrobe,
    state.body,
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
  // Small talk and negations ("don't take it off") are never quoted: the words themselves read as a cue.
  const action = await planAction(requestText, intents, state);
  return {
    prompt: buildPrompt({ creator, state, action, withWardrobe: false }),
    settlePrompt: settleFor(creator, nextState),
    nextState,
  };
};
