// One literal, present-tense sentence of visible body motion per request: the only thing LongLive's text encoder is steered by.
import { GROQ_TEXT_MODEL, createGroqChatCompletion } from "@/lib/groq";
import type {
  BeatIntent,
  Body,
  GarmentId,
  LiveState,
  Pose,
  Wardrobe,
} from "../contract";
import { HELD_OBJECTS, isIntentSatisfied } from "../intents";
import { correctActionTypos } from "./actionTypos";
import { planBeatIntent } from "./planClip";

// A request with a minor cue fails closed to the neutral reaction, before it reaches the LLM or a template.
export const MINOR_CUE_RE =
  /\b(teen\w*|child\w*|kid|kids|minor|minors|underage|under-age|schoolgirl\w*|school uniform|loli\w*|little girl|barely legal|jailbait)\b/i;

// Generated text is held to a stricter bar: it must never frame her as young at all.
export const YOUTH_WORD_RE =
  /\b(young|younger|youth\w*|girl|girls|girlish)\b|\b(teen\w*|child\w*|kid|kids|minor|minors|underage|under-age|schoolgirl\w*|school uniform|loli\w*|little girl|barely legal|jailbait)\b/i;

// Negations and meta words steer a T5-conditioned video model toward the very thing they name.
const NEGATION_RE = /\b(not|no|never|without|nothing)\b|n't\b/i;
const META_RE =
  /\b(zoom\w*|pan|pans|panning|text|caption\w*|subtitle\w*|watermark\w*|logo|screen|letters|words|says|speaks|talks|mouths|web ?cam\w*|live ?stream\w*)\b/i;
const REFUSAL_RE =
  /\b(sorry|cannot|can't|unable|as an ai|i won't|i will not|not able)\b/i;

const MIN_WORDS = 6;
const MAX_WORDS = 60;
// Past this the template is used, so a slow Groq call never holds up the prompt switch.
const LLM_TIMEOUT_MS = 700;

export const REACT_ACTION =
  "She laughs softly and smiles warmly into the camera, tilting her head playfully.";

export const SETTLE_ACTION =
  "She relaxes and smiles softly into the camera, playing with a strand of her hair.";

export const GREETING_ACTION =
  "She smiles warmly into the camera and waves hello with one hand, then settles in and relaxes.";

// Clip mode's check-in, minus "glances at the chat": a named screen or chat reads as a cue to draw one.
export const CHECK_IN_ACTION =
  "She looks back into the camera with a warm smile, tilting her head as she leans in a little closer.";

const WAVE_ACTION =
  "She lifts her right hand high and waves it side to side at the camera, smiling brightly.";
const KISS_ACTION =
  "She presses her fingertips to her puckered lips, then sweeps her hand forward toward the camera, blowing a kiss.";
const WINK_ACTION =
  "She tilts her head and gives the camera a slow playful wink with a big smile.";
const SMILE_ACTION =
  "She gives the camera a big warm smile and a little shrug of her shoulders.";
const SHOW_BREASTS_ACTION =
  "She cups her bare breasts in both hands and presents them to the camera, her nipples clearly visible.";
const SHOW_BOTTOM_ACTION =
  "She turns around and shows her bottom to the camera, looking back over her shoulder with a smile.";
const SHOW_NAKED_ACTION =
  "She shows off her fully naked body to the camera, turning slowly from side to side.";
const RISE_LEAD_IN = "She stands up onto her feet.";
// planClip's SIT_UP_LINE: panties and bottoms cannot come off or go on from these poses.
const SIT_UP_LEAD_IN = "She sits up on the edge of the bed.";
const NEEDS_SIT_UP = new Set<Pose>([
  "lying",
  "onAllFours",
  "bentOver",
  "kneeling",
]);

type Act = Extract<BeatIntent, { type: "act" }>["act"];
type FetchableProp = Extract<BeatIntent, { type: "fetchProp" }>["prop"];
type PropMode = Extract<BeatIntent, { type: "useProp" }>["mode"];
type Facing = Body["facing"];
type Posture = "standing" | "sitting" | "lying";

// planClip's posture(): every non-standing, non-lying pose undresses like sitting.
const posture = (pose: Pose): Posture =>
  pose === "standing" ? "standing" : pose === "lying" ? "lying" : "sitting";

const isPlural = (description: string): boolean =>
  /s$/i.test(description.trim());

const itFor = (description: string): string =>
  isPlural(description) ? "them" : "it";

const wornLayer = (wardrobe: Wardrobe, ids: GarmentId[]): string | null => {
  const id = ids.find((garment) => wardrobe[garment].on);
  return id ? wardrobe[id].description : null;
};

// Mirrors planClip's removalChoreo: the same garment, posture and skirt branches as one untimed clause.
const REMOVAL_CLAUSE: Record<
  GarmentId,
  (description: string, pose: Pose, wornAfter: Set<GarmentId>) => string
> = {
  top: (description, _pose, wornAfter) =>
    wornAfter.has("bra")
      ? `pulls her ${description} up over her head and tosses it aside, showing her bra`
      : `pulls her ${description} up over her head and tosses it aside, baring her naked breasts and nipples`,
  bra: (description) =>
    `reaches behind her back, unhooks her ${description} and slides it off her arms, baring her naked breasts with visible nipples`,
  bottom: (description, pose, wornAfter) => {
    const reveal = wornAfter.has("panties")
      ? "showing her panties"
      : "her bare vulva visible";
    if (/skirt/i.test(description))
      return `unzips her ${description} at the hip, lets it drop to her feet and steps out of it, ${reveal}`;
    return posture(pose) === "standing"
      ? `pushes her ${description} down over her hips, bends forward and steps out of ${itFor(description)}, ${reveal}`
      : `lifts her hips and slides her ${description} down her legs and off over her feet, ${reveal}`;
  },
  panties: (description, pose) => {
    const it = itFor(description);
    switch (posture(pose)) {
      case "standing":
        return `hooks her thumbs into her ${description}, pushes ${it} down her legs and steps out of ${it}, her bare vulva visible`;
      case "lying":
        return `lifts her hips, slides her ${description} down her thighs and pulls ${it} off over her feet, her bare vulva visible`;
      case "sitting":
        return `hooks her thumbs into her ${description}, lifts her hips off the seat and slides ${it} down her legs and off, her bare vulva visible`;
    }
  },
};

// Mirrors planClip's dressChoreo.
const DRESS_CLAUSE: Record<
  GarmentId,
  (description: string, pose: Pose) => string
> = {
  top: (description) =>
    `picks up her ${description} and pulls it down over her head, smoothing it over her body`,
  bra: (description) =>
    `picks up her ${description}, slides the straps over her shoulders and hooks the clasp behind her back`,
  bottom: (description, pose) =>
    /skirt/i.test(description)
      ? `steps into her ${description}, draws it up to her waist and zips it at the hip`
      : posture(pose) === "standing"
        ? `steps into her ${description} and pulls ${itFor(description)} up her legs, fastening the waistband`
        : `slides her feet into her ${description} and draws ${itFor(description)} up her thighs, lifting her hips to fasten the waistband`,
  panties: (description, pose) =>
    posture(pose) === "standing"
      ? `steps into her ${description} and pulls ${itFor(description)} up her legs to her hips`
      : `slides her feet into her ${description}, draws ${itFor(description)} up her thighs and lifts her hips to settle ${itFor(description)} in place`,
};

type WardrobeIntent = Extract<
  BeatIntent,
  { type: "removeGarment" | "addGarment" }
>;

const wardrobeSentence = (
  intents: WardrobeIntent[],
  state: LiveState,
): string => {
  const worn = new Set(
    (["top", "bottom", "bra", "panties"] as const).filter(
      (id) => state.wardrobe[id].on,
    ),
  );
  const pose = state.body.pose;
  const clauses = intents.map((intent) => {
    const description = state.wardrobe[intent.garment].description;
    if (intent.type === "addGarment") {
      worn.add(intent.garment);
      return DRESS_CLAUSE[intent.garment](description, pose);
    }
    worn.delete(intent.garment);
    return REMOVAL_CLAUSE[intent.garment](description, pose, worn);
  });
  const naked =
    worn.size === 0 && intents.every((i) => i.type === "removeGarment");
  if (clauses.length === 1) {
    return `She ${clauses[0]}${naked ? ", now fully naked" : ""}.`;
  }
  const garments = intents.map(
    (i) => `her ${state.wardrobe[i.garment].description}`,
  );
  return naked
    ? `She undresses one piece at a time, taking off ${garments.join(", then ")}, until she is fully naked, her bare breasts, nipples and vulva visible.`
    : `She ${clauses.join(", then ")}.`;
};

// Mirrors planClip's POSE_DESCRIPTION, as a motion into the pose rather than a state.
const POSE_MOTION: Record<Pose, string> = {
  standing: "gets up onto her feet and stands tall, her whole body in view",
  sitting: "sits down comfortably and leans back on her hands",
  leaning: "leans back against the pillows behind her",
  kneeling: "kneels upright with her knees apart and her hands on her thighs",
  lying: "lies down on her back across the bed",
  onAllFours: "gets down on her hands and knees",
  bentOver: "bends forward at the waist with her hands braced on her knees",
};

// Mirrors planClip's FACING_TRANSITION_LABEL.
const FACING_CLAUSE: Record<Facing, string> = {
  camera: "facing the camera",
  away: "with her back to the camera, looking over her shoulder",
  side: "turned at an angle to the camera",
};

const FRAMING_ACTIONS: Record<Body["framing"], string> = {
  torso:
    "She leans in close to the camera so her face and chest fill the frame.",
  wider: "She steps back from the camera so her whole body is in view.",
  medium:
    "She settles back to a comfortable distance from the camera, in view from the waist up.",
};

const FETCH_ACTIONS: Record<FetchableProp, string> = {
  vibrator:
    "She reaches off to the side, picks up her vibrator and holds it up to show the camera.",
  dildo:
    "She reaches off to the side, picks up her dildo and holds it up to show the camera.",
  drink:
    "She reaches off to the side, picks up her drink and holds it in one hand.",
};

const USE_PROP_ACTIONS: Record<PropMode, (prop: string) => string> = {
  mouth: (prop) =>
    `She brings her ${prop} to her mouth and slowly licks and sucks its tip, looking at the camera.`,
  external: (prop) =>
    `She presses her ${prop} between her thighs and moves it slowly against herself, eyes on the camera.`,
};

const gestureAction = (text: string): string => {
  if (/\bkiss/i.test(text)) return KISS_ACTION;
  if (/\bwink/i.test(text)) return WINK_ACTION;
  if (/\b(wave|waving|hi|hello|hey)\b/i.test(text)) return WAVE_ACTION;
  return SMILE_ACTION;
};

// The clip regex puts clip-mode tease text in detail; LongLive keys off which garment it names.
const teaseAction = (
  detail: string | undefined,
  wardrobe: Wardrobe,
): string => {
  if (detail && /strap/i.test(detail))
    return `She hooks one finger under her ${wardrobe.bra.description} strap, slides it off her shoulder, holds it there, then lets it snap back into place.`;
  if (detail && /waistband|panties/i.test(detail))
    return `She hooks a thumb into the waistband of her ${wardrobe.panties.description}, tugs it out from her hip, then lets it snap back.`;
  if (detail && /hem/i.test(detail))
    return `She lifts the hem of her ${wardrobe.top.description} a few inches, holds it up, then lets it drop back down.`;
  const layer = wornLayer(wardrobe, ["top", "bra", "panties", "bottom"]);
  return layer
    ? `She runs her fingertips slowly along the edge of her ${layer}, tugging it gently, teasing the camera with a playful smile.`
    : "She runs her fingertips slowly down her neck and over her hips, teasing the camera with a playful smile.";
};

// Mirrors planAct: the same pose, facing and wardrobe branches, one untimed sentence each.
const ACT_ACTIONS: Record<
  Act,
  (
    intent: Extract<BeatIntent, { type: "act" }>,
    state: LiveState,
    text: string,
  ) => string
> = {
  grind: (_intent, { body }) =>
    body.pose === "onAllFours"
      ? "On her hands and knees with her back arched, she rocks and grinds her hips toward the camera in a slow, steady rhythm."
      : "She rolls her hips slowly in a grinding motion toward the camera, hands sliding along her thighs.",
  twerk: () =>
    "She turns her back to the camera, bends her knees and twerks, shaking and bouncing her hips and bottom to the beat.",
  bounce: (_intent, { body, wardrobe }) => {
    const surface = body.pose === "standing" ? "on her heels" : "on her seat";
    const top = wardrobe.top.on
      ? `, her ${wardrobe.top.description} moving with her`
      : "";
    return `She bounces up and down ${surface} in rhythm, her breasts moving with each bounce${top}.`;
  },
  spread: (intent, { body }) => {
    if (intent.detail === "ass") {
      const lead =
        body.pose === "onAllFours" || body.pose === "bentOver"
          ? "Bent forward with her back to the camera"
          : "She turns her back to the camera and bends forward at the waist, then";
      return `${lead}, she reaches back with both hands and pulls her bottom apart toward the camera, looking back over her shoulder.`;
    }
    return body.pose === "standing"
      ? "She steps her feet wide apart and bends forward slightly, her legs spread toward the camera."
      : body.pose === "lying"
        ? "Lying on her back, she draws her knees up and lets them fall open, her legs spread toward the camera."
        : "She draws her knees up and lets them fall open, her legs spread toward the camera.";
  },
  sway: () =>
    "Bent forward at the waist, she sways and arches her back, her hips rocking slowly side to side.",
  crawl: () =>
    "On her hands and knees, she crawls slowly toward the camera until her body fills more of the frame.",
  spin: () =>
    "She turns slowly all the way around, showing her back, then faces the camera again with a smile.",
  gesture: (_intent, _state, text) => gestureAction(text),
  tongue: () =>
    "She sticks her tongue out playfully at the camera, then slowly licks her lips.",
  tease: (intent, { wardrobe }) => teaseAction(intent.detail, wardrobe),
  dance: () =>
    "She dances to music, swaying her hips side to side, rolling her shoulders and running her hands through her hair.",
  doggy: () =>
    "She lowers herself onto her hands and knees with her hips toward the camera, arches her back and rocks her hips slowly, glancing back over her shoulder.",
  spank: (_intent, { body }) =>
    body.facing === "camera"
      ? "She turns her hips to the side and gives her own bottom a few firm playful spanks, eyes on the camera."
      : "She gives her own bottom a few firm playful spanks, eyes on the camera.",
  boobPlay: (_intent, { wardrobe }) => {
    const layer = wornLayer(wardrobe, ["bra", "top"]);
    return layer
      ? `She cups her breasts in both hands over her ${layer}, squeezing them gently, thumbs circling slowly.`
      : "She cups her bare breasts in both hands, squeezing them gently, thumbs circling slowly over her nipples.";
  },
};

// planAct's "0-2s: she rises to her feet" lead-in.
const ACTS_FROM_STANDING = new Set<Act>(["twerk", "dance", "spin"]);

// "can you run your hands through your hair" -> "She runs her hands through her hair."
const rephraseRequest = (text: string): string | null => {
  const core = text
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(
      /^(please|pls|can you|could you|would you|will you|now|babe|baby)\s+/gi,
      "",
    )
    .replace(/\s+(please|pls|for me|for us)$/i, "")
    .replace(/\b(me|us)\b/gi, "the camera")
    .replace(/\byourself\b/gi, "herself")
    .replace(/\byour\b/gi, "her")
    .replace(/\byou\b/gi, "her")
    .trim();
  const words = core.split(/\s+/);
  if (words.length === 0 || core.length === 0) return null;
  const verb = words[0].toLowerCase();
  const third = /(s|sh|ch|x|z|o)$/.test(verb)
    ? `${verb}es`
    : /[^aeiou]y$/.test(verb)
      ? `${verb.slice(0, -1)}ies`
      : `${verb}s`;
  const sentence = `She ${[third, ...words.slice(1)].join(" ")}.`;
  return NEGATION_RE.test(sentence) || META_RE.test(sentence) ? null : sentence;
};

// A clip hold line is kept when it is a positive motion; "holds her exact pose" lines are the reaction instead.
const holdAction = (line: string): string | null => {
  const sentence = line.trim().replace(/\bwebcam\b/gi, "camera");
  if (!sentence.startsWith("She ")) return null;
  if (/\b(holds|stays)\b[^.]*\b(pose|as she is)\b/i.test(sentence)) return null;
  if ([YOUTH_WORD_RE, NEGATION_RE, META_RE].some((re) => re.test(sentence)))
    return null;
  return sentence;
};

const restAction = ({ body, baselineBody }: LiveState): string => {
  const steps: string[] = [];
  if (HELD_OBJECTS.has(body.prop)) steps.push(`sets her ${body.prop} aside`);
  if (body.hands === "onBody") steps.push("eases her hand off her body");
  if (body.pose !== baselineBody.pose || body.facing !== baselineBody.facing)
    steps.push(
      `${POSE_MOTION[baselineBody.pose]}, ${FACING_CLAUSE[baselineBody.facing]}`,
    );
  steps.push("rests her hands in her lap and relaxes");
  return `She ${steps.join(", then ")}.`;
};

const touchAction = ({ wardrobe, body }: LiveState): string => {
  const covering = wardrobe.panties.on
    ? `over her ${wardrobe.panties.description}`
    : wardrobe.bottom.on
      ? `over her ${wardrobe.bottom.description}`
      : "against her bare skin";
  const position =
    body.pose === "standing"
      ? "Standing with her legs slightly apart, she slides one hand down the front of her body"
      : body.pose === "lying" || body.pose === "onAllFours"
        ? "She reaches one hand back between her legs"
        : "Sitting with her knees apart, she slides one hand down between her legs";
  return `${position} and rubs herself slowly ${covering}, her hips rocking gently as she bites her lip.`;
};

// One sentence per intent from the body it runs from; null only for a line that is not a motion.
const intentSentence = (
  intent: BeatIntent,
  state: LiveState,
  text: string,
): string | null => {
  switch (intent.type) {
    case "removeGarment":
    case "addGarment":
      return wardrobeSentence([intent], state);
    case "pose":
      return `She ${POSE_MOTION[intent.pose]}, ${FACING_CLAUSE[intent.facing]}.`;
    case "framing":
      return FRAMING_ACTIONS[intent.framing];
    case "fetchProp":
      return FETCH_ACTIONS[intent.prop];
    case "useProp": {
      const prop = HELD_OBJECTS.has(state.body.prop) ? state.body.prop : "toy";
      return USE_PROP_ACTIONS[intent.mode](prop);
    }
    case "rest":
      return restAction(state);
    case "touch":
      return touchAction(state);
    case "act":
      return ACT_ACTIONS[intent.act](intent, state, text);
    case "hold":
      return holdAction(intent.line);
    case "verbatim":
      return rephraseRequest(intent.text);
  }
};

// Mirrors planBeatIntent's lead-ins: set a held prop down, sit up to undress below the waist, and planAct's rise to her feet.
// Unlike planBeatIntent, a hold keeps the prop: in one sentence "sets her drink aside, then takes a sip" reads backwards.
const setsPropDown = (intent: BeatIntent, body: Body): boolean =>
  body.hands === "holdingProp" &&
  HELD_OBJECTS.has(body.prop) &&
  intent.type !== "fetchProp" &&
  intent.type !== "useProp" &&
  intent.type !== "rest" &&
  intent.type !== "hold";

const sitsUp = (intent: BeatIntent, body: Body): boolean =>
  (intent.type === "removeGarment" || intent.type === "addGarment") &&
  (intent.garment === "panties" || intent.garment === "bottom") &&
  NEEDS_SIT_UP.has(body.pose);

const risesToFeet = (intent: BeatIntent, body: Body): boolean =>
  intent.type === "act" &&
  ACTS_FROM_STANDING.has(intent.act) &&
  body.pose !== "standing";

// The lead-in sentences and the body they leave her in, so the intent's own sentence reads from there.
const leadIns = (
  intent: BeatIntent,
  body: Body,
): { steps: string[]; body: Body } => {
  const steps: string[] = [];
  let next = body;
  if (setsPropDown(intent, next)) {
    steps.push(`She sets her ${next.prop} aside.`);
    next = { ...next, prop: "none", hands: "free", contact: "none" };
  }
  if (sitsUp(intent, next)) {
    steps.push(SIT_UP_LEAD_IN);
    next = { ...next, pose: "sitting" };
  }
  if (risesToFeet(intent, next)) {
    steps.push(RISE_LEAD_IN);
    next = { ...next, pose: "standing" };
  }
  return { steps, body: next };
};

// Joins the steps into one sentence: "She stands up..., then she turns...".
const MAX_STEPS = 4;
const joinSteps = (sentences: string[]): string =>
  sentences
    .slice(0, MAX_STEPS)
    .map((sentence, index) =>
      index === 0
        ? sentence.replace(/\.$/, "")
        : `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`.replace(
            /\.$/,
            "",
          ),
    )
    .join(", then ")
    .concat(".");

// A request with no physical step still gets a literal motion when it names her body, since the state may already match.
const bodyRequestAction = (text: string, state: LiveState): string | null => {
  const allOff = (["top", "bottom", "bra", "panties"] as const).every(
    (id) => !state.wardrobe[id].on,
  );
  if (/\b(tits|boobs|breasts|titties|nipples)\b/i.test(text))
    return SHOW_BREASTS_ACTION;
  if (/\b(ass|butt|booty|bum|bottom)\b/i.test(text)) return SHOW_BOTTOM_ACTION;
  if (allOff && /\b(strip|naked|nude|undress)\b/i.test(text))
    return SHOW_NAKED_ACTION;
  return null;
};

export type ActionPlan = {
  sentence: string;
  // False for small talk: it plays the reaction and never goes to the LLM.
  physical: boolean;
};

export const templateAction = (
  requestText: string,
  intents: BeatIntent[],
  state: LiveState,
): ActionPlan => {
  const text = correctActionTypos(requestText);
  if (MINOR_CUE_RE.test(text))
    return { sentence: REACT_ACTION, physical: false };
  const steps: string[] = [];
  let current = state;
  let wardrobeRun: WardrobeIntent[] = [];
  let wardrobeFrom = state;
  const flushWardrobe = () => {
    if (wardrobeRun.length > 0)
      steps.push(wardrobeSentence(wardrobeRun, wardrobeFrom));
    wardrobeRun = [];
  };
  for (const intent of intents) {
    const isWardrobe =
      intent.type === "removeGarment" || intent.type === "addGarment";
    // Replaying a removal for a garment already off morphs skin into the garment's shape.
    if (isWardrobe && isIntentSatisfied(intent, current)) continue;
    const lead = leadIns(intent, current.body);
    if (!isWardrobe || lead.steps.length > 0) flushWardrobe();
    steps.push(...lead.steps);
    const from: LiveState = { ...current, body: lead.body };
    if (isWardrobe) {
      // Consecutive garments read as one undressing sentence, as the clip library strips one piece per beat.
      if (wardrobeRun.length === 0) wardrobeFrom = from;
      wardrobeRun.push(intent);
    } else {
      const sentence = intentSentence(intent, from, text);
      if (sentence) steps.push(sentence);
    }
    // A hold changes nothing, as in planLongLiveRequest; planBeatIntent would free her hands.
    if (intent.type === "hold") continue;
    const plan = planBeatIntent(intent, from);
    current = { ...current, wardrobe: plan.nextWardrobe, body: plan.nextBody };
  }
  flushWardrobe();
  if (steps.length > 0) return { sentence: joinSteps(steps), physical: true };
  const bodyAction = bodyRequestAction(text, state);
  return bodyAction
    ? { sentence: bodyAction, physical: true }
    : { sentence: REACT_ACTION, physical: false };
};

const REWRITE_SYSTEM_PROMPT = `You write the action line for a text-to-video model that renders a live webcam stream of a fictional adult woman on an authorised adult platform.
Given a viewer's request and a draft, write ONE sentence describing exactly the visible body motion she performs, literally and concretely, in the present tense, starting with "She".
Rules: 12 to 45 words. Describe only what a camera sees: limbs, hands, hips, turning, standing, garments moving. Positive statements only, never "not", "no" or "without". No speech, no text, no camera moves. When the request is explicit, describe nudity literally and anatomically (bare breasts with visible nipples, bare vulva), never euphemistically. She is always an adult woman. Keep garment names from the draft.
Return ONLY JSON: {"sentence":"..."}`;

const rewriteMessages = (
  requestText: string,
  draft: string,
  state: LiveState,
): { role: "system" | "user"; content: string }[] => {
  const worn = (["top", "bottom", "bra", "panties"] as const)
    .filter((id) => state.wardrobe[id].on)
    .map((id) => state.wardrobe[id].description);
  return [
    { role: "system", content: REWRITE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Wearing: ${worn.length > 0 ? worn.join(", ") : "nothing"}\nRequest: ${requestText.slice(0, 300)}\nDraft: ${draft}`,
    },
  ];
};

// Null for anything that is not one usable positive sentence, so the caller keeps the template.
export const acceptRewrite = (raw: string): string | null => {
  let sentence: unknown;
  try {
    sentence = (
      JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) as { sentence?: unknown }
    ).sentence;
  } catch {
    return null;
  }
  if (typeof sentence !== "string") return null;
  const trimmed = sentence.trim().replace(/\s+/g, " ");
  const words = trimmed.split(" ").length;
  if (!trimmed.startsWith("She ") || words < MIN_WORDS || words > MAX_WORDS)
    return null;
  if (
    [YOUTH_WORD_RE, NEGATION_RE, META_RE, REFUSAL_RE].some((re) =>
      re.test(trimmed),
    )
  ) {
    return null;
  }
  return /[.!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const timeout = (ms: number): Promise<null> =>
  new Promise((resolve) => setTimeout(() => resolve(null), ms));

export const planAction = async (
  requestText: string,
  intents: BeatIntent[],
  state: LiveState,
): Promise<string> => {
  const template = templateAction(requestText, intents, state);
  if (!template.physical) return template.sentence;
  const rewrite = async (): Promise<string | null> => {
    try {
      const completion = await createGroqChatCompletion({
        model: GROQ_TEXT_MODEL,
        reasoningEffort: "low",
        temperature: 0,
        responseFormat: { type: "json_object" },
        messages: rewriteMessages(requestText, template.sentence, state),
      });
      return acceptRewrite(completion.choices[0]?.message?.content ?? "");
    } catch (error) {
      console.warn("longliveAction: rewrite failed, using template", error);
      return null;
    }
  };
  return (
    (await Promise.race([rewrite(), timeout(LLM_TIMEOUT_MS)])) ??
    template.sentence
  );
};
