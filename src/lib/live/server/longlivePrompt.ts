// LongLive has no session premise: every prompt it gets replaces the last, so each one restates the whole scene.
import { isIntentSatisfied } from "../intents";
import type { BeatIntent, CreatorProfile, LiveState } from "../contract";
import {
  cameraLockLine,
  describeState,
  lookLockLine,
  planBeatIntent,
  resolveIntents,
  wardrobeLockLine,
} from "./planClip";

const MAX_PROMPT_CHARS = 2000;

const SCENE_LINE =
  "A continuous, uncut, real-time solo webcam livestream, shot on a fixed phone camera in portrait. One adult woman, alone, live for her viewers.";

const STEADY_LINE =
  "Small natural movements, no cuts, no scene changes. No text overlays, no watermark, no subtitles, no UI.";

// The stream is video only, so she never mouths words that nobody hears.
const SILENT_LINE = "She does not speak; lips relaxed, no mouthing words.";

const GREETING_ACTION =
  "ACTION: she has just gone live, settles into frame, smiles at the camera and waves hello to her viewers.";

const SETTLE_ACTION =
  "ACTION: she holds this position, relaxed, smiling and chatting with her viewers through the lens.";

const REACT_ACTION =
  "ACTION: she reads a viewer's message, smiles and reacts warmly to the camera, relaxed and flirty.";

type WardrobeIntent = Extract<
  BeatIntent,
  { type: "removeGarment" | "addGarment" }
>;

const isWardrobeIntent = (intent: BeatIntent): intent is WardrobeIntent =>
  intent.type === "removeGarment" || intent.type === "addGarment";

export type LongLiveStep = {
  prompt: string;
  // The scene to fall back to once the action has played, so the last prompt never loops an action forever.
  settlePrompt: string;
  nextState: LiveState;
};

const buildPrompt = (params: {
  creator: CreatorProfile;
  state: LiveState;
  nextState: LiveState;
  action: string;
  wardrobeChange: string | null;
}): string => {
  const { creator, state, nextState, wardrobeChange } = params;
  const lines = [
    SCENE_LINE,
    lookLockLine(creator.lookLock),
    wardrobeChange
      ? `NOW: she is ${describeState(state.wardrobe, state.body)} ${wardrobeChange} Afterwards she is ${describeState(nextState.wardrobe, nextState.body)}`
      : `NOW: she is ${describeState(nextState.wardrobe, nextState.body)}`,
    // Positive-only hold line, so a prompt without a wardrobe change never names undressing.
    wardrobeChange ? null : wardrobeLockLine(nextState.wardrobe),
    params.action,
    cameraLockLine(nextState.body.framing),
    STEADY_LINE,
    SILENT_LINE,
    // Last, so an overlong room description is what gets trimmed, not the action.
    `ROOM: ${state.surroundings}`,
  ];
  return lines
    .filter((line): line is string => line !== null)
    .join(" ")
    .slice(0, MAX_PROMPT_CHARS);
};

const describeWardrobeChange = (
  intents: WardrobeIntent[],
  state: LiveState,
): string => {
  const steps = intents.map((intent) => {
    const description = state.wardrobe[intent.garment].description;
    return intent.type === "removeGarment"
      ? `she takes off her ${description} with her hands and sets it aside`
      : `she puts her ${description} back on with her hands`;
  });
  const sentence =
    steps.length === 1
      ? `Now ${steps[0]}.`
      : `One garment at a time, ${steps.join(", then ")}.`;
  return `${sentence} The fabric moves only where her hands move it.`;
};

const settleFor = (creator: CreatorProfile, state: LiveState): string =>
  buildPrompt({
    creator,
    state,
    nextState: state,
    action: SETTLE_ACTION,
    wardrobeChange: null,
  });

export const planLongLiveGreeting = (
  creator: CreatorProfile,
  state: LiveState,
): LongLiveStep => ({
  prompt: buildPrompt({
    creator,
    state,
    nextState: state,
    action: GREETING_ACTION,
    wardrobeChange: null,
  }),
  settlePrompt: settleFor(creator, state),
  nextState: state,
});

export const planLongLiveRequest = (
  creator: CreatorProfile,
  state: LiveState,
  requestText: string,
): LongLiveStep => {
  const intents = resolveIntents(
    requestText,
    state.wardrobe,
    state.body,
  ).filter((intent) => !isIntentSatisfied(intent, state));
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
  const wardrobeIntents = intents.filter(isWardrobeIntent);
  const physical = intents.some((intent) => intent.type !== "hold");
  // Small talk and negations ("don't take it off") are never quoted: the words themselves read as a cue.
  const action = physical
    ? `ACTION: a viewer just asked: "${requestText.replace(/"/g, "'")}". She does exactly that now, playfully and fully.`
    : REACT_ACTION;
  return {
    prompt: buildPrompt({
      creator,
      state,
      nextState,
      action,
      wardrobeChange:
        wardrobeIntents.length > 0
          ? describeWardrobeChange(wardrobeIntents, state)
          : null,
    }),
    settlePrompt: settleFor(creator, nextState),
    nextState,
  };
};
