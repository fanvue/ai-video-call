// One literal, present-tense sentence of visible body motion per request: the only thing LongLive's text encoder is steered by.
import { GROQ_TEXT_MODEL, createGroqChatCompletion } from "@/lib/groq";
import type { BeatIntent, GarmentId, LiveState } from "../contract";
import { isIntentSatisfied } from "../intents";
import { correctActionTypos } from "./actionTypos";

// A request with a minor cue fails closed to the neutral reaction, before it reaches the LLM or a template.
export const MINOR_CUE_RE =
  /\b(teen\w*|child\w*|kid|kids|minor|minors|underage|under-age|schoolgirl\w*|school uniform|loli\w*|little girl|barely legal|jailbait)\b/i;

// Generated text is held to a stricter bar: it must never frame her as young at all.
export const YOUTH_WORD_RE =
  /\b(young|younger|youth\w*|girl|girls|girlish)\b|\b(teen\w*|child\w*|kid|kids|minor|minors|underage|under-age|schoolgirl\w*|school uniform|loli\w*|little girl|barely legal|jailbait)\b/i;

// Negations and meta words steer a T5-conditioned video model toward the very thing they name.
const NEGATION_RE = /\b(not|no|never|without|nothing)\b|n't\b/i;
const META_RE =
  /\b(zoom\w*|pan|pans|panning|text|caption\w*|subtitle\w*|watermark\w*|logo|screen|letters|words|says|speaks|talks|mouths)\b/i;
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

const SPIN_ACTION =
  "She stands up and turns slowly all the way around, showing her back, then faces the camera again with a smile.";
const WAVE_ACTION =
  "She lifts her right hand high and waves it side to side at the camera, smiling brightly.";
const KISS_ACTION =
  "She presses her fingertips to her puckered lips, then sweeps her hand forward toward the camera, blowing a kiss.";
const WINK_ACTION =
  "She tilts her head and gives the camera a slow playful wink with a big smile.";
const DANCE_ACTION =
  "She stands up and dances to music, swaying her hips side to side, rolling her shoulders and running her hands through her hair.";
const SHOW_BREASTS_ACTION =
  "She cups her bare breasts in both hands and presents them to the camera, her nipples clearly visible.";
const SHOW_BOTTOM_ACTION =
  "She turns around and shows her bottom to the camera, looking back over her shoulder with a smile.";
const SHOW_NAKED_ACTION =
  "She shows off her fully naked body to the camera, turning slowly from side to side.";

const isPlural = (description: string): boolean =>
  /s$/i.test(description.trim());

const removalClause = (
  garment: GarmentId,
  description: string,
  wornAfter: Set<GarmentId>,
): string => {
  const it = isPlural(description) ? "them" : "it";
  switch (garment) {
    case "top":
      return wornAfter.has("bra")
        ? `pulls her ${description} off and tosses it aside, showing her bra`
        : `pulls her ${description} off and tosses it aside, baring her naked breasts and nipples`;
    case "bra":
      return `reaches behind her back, unhooks her ${description} and slides it off her arms, baring her naked breasts with visible nipples`;
    case "bottom":
      return wornAfter.has("panties")
        ? `slides her ${description} down her legs and steps out of ${it}, showing her panties`
        : `slides her ${description} down her legs and steps out of ${it}, her bare vulva visible`;
    case "panties":
      return `hooks her thumbs into her ${description}, slides ${it} down her legs and steps out of ${it}, her bare vulva visible`;
  }
};

const wardrobeSentence = (
  intents: Extract<BeatIntent, { type: "removeGarment" | "addGarment" }>[],
  state: LiveState,
): string => {
  const worn = new Set(
    (["top", "bottom", "bra", "panties"] as const).filter(
      (id) => state.wardrobe[id].on,
    ),
  );
  const clauses = intents.map((intent) => {
    const description = state.wardrobe[intent.garment].description;
    if (intent.type === "addGarment") {
      worn.add(intent.garment);
      return `picks up her ${description} and puts ${isPlural(description) ? "them" : "it"} back on`;
    }
    worn.delete(intent.garment);
    return removalClause(intent.garment, description, worn);
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

const POSE_ACTIONS: Record<string, string> = {
  standing:
    "She gets up onto her feet and stands tall facing the camera, her whole body in view.",
  sitting:
    "She sits down comfortably facing the camera and leans back on her hands.",
  lying:
    "She lies down on her back across the bed, turning her head to look at the camera.",
  kneeling:
    "She kneels upright facing the camera, knees apart, hands resting on her thighs.",
  onAllFours:
    "She gets down on her hands and knees facing the camera and looks up with a smile.",
  bentOver:
    "She turns her back to the camera and bends forward at the waist, looking back over her shoulder.",
  leaning: "She leans toward the camera, resting her forearms on her knees.",
};

const FRAMING_ACTIONS: Record<string, string> = {
  torso:
    "She leans in close to the camera so her face and chest fill the frame.",
  wider: "She steps back from the camera so her whole body is in view.",
  medium: "She settles back to a comfortable distance from the camera.",
};

const ACT_ACTIONS: Record<string, string> = {
  twerk:
    "She turns her back to the camera, bends her knees and twerks, bouncing her bottom in rhythm.",
  grind:
    "She rolls her hips slowly in a grinding motion, hands sliding along her thighs.",
  bounce:
    "She bounces up and down in rhythm, her breasts moving with each bounce.",
  spread: "She leans back and spreads her legs wide toward the camera.",
  sway: "She sways her hips slowly side to side, running her hands down her sides.",
  crawl: "She crawls toward the camera on her hands and knees.",
  spin: SPIN_ACTION,
  tongue: "She sticks her tongue out playfully at the camera and laughs.",
  tease:
    "She runs her fingertips slowly along her neckline and down over her hips, teasing the camera with a playful smile.",
  dance: DANCE_ACTION,
  doggy:
    "She gets on her hands and knees with her back to the camera, arching her back and looking over her shoulder.",
  spank: "She turns to the side and gives her own bottom a firm playful spank.",
  boobPlay:
    "She cups her breasts in both hands and squeezes them together, smiling at the camera.",
};

const PROP_NAMES: Record<string, string> = {
  vibrator: "vibrator",
  dildo: "dildo",
  drink: "drink",
};

const gestureAction = (text: string): string => {
  if (/\bkiss/i.test(text)) return KISS_ACTION;
  if (/\bwink/i.test(text)) return WINK_ACTION;
  if (/\b(wave|waving|hi|hello|hey)\b/i.test(text)) return WAVE_ACTION;
  return "She gives the camera a big warm smile and a little shrug of her shoulders.";
};

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
  return `She ${[third, ...words.slice(1)].join(" ")}.`;
};

const intentSentence = (
  intent: BeatIntent,
  text: string,
  state: LiveState,
): string | null => {
  switch (intent.type) {
    case "pose":
      return intent.facing === "away" && intent.pose !== "bentOver"
        ? `${POSE_ACTIONS[intent.pose].replace(/ facing the camera/, "")} She turns her back to the camera and looks over her shoulder.`
        : POSE_ACTIONS[intent.pose];
    case "framing":
      return FRAMING_ACTIONS[intent.framing];
    case "fetchProp":
      return `She reaches off to the side, picks up her ${PROP_NAMES[intent.prop]} and holds it up to show the camera.`;
    case "useProp": {
      const prop =
        state.body.prop === "none" || state.body.prop === "fetching"
          ? "toy"
          : state.body.prop;
      return intent.mode === "mouth"
        ? `She licks and sucks the tip of her ${prop} slowly, looking at the camera.`
        : `She presses her ${prop} between her thighs and moves it slowly against herself.`;
    }
    case "rest":
      return "She puts everything down, rests her hands in her lap and relaxes.";
    case "touch":
      return "She slides one hand slowly down her body and between her thighs, touching herself and biting her lip.";
    case "act":
      return intent.act === "gesture"
        ? gestureAction(text)
        : ACT_ACTIONS[intent.act];
    case "verbatim":
      return rephraseRequest(intent.text);
    case "hold":
    case "removeGarment":
    case "addGarment":
      return null;
  }
};

// Joins up to three steps into one sentence: "She stands up..., then she turns...".
const joinSteps = (sentences: string[]): string =>
  sentences
    .slice(0, 3)
    .map((sentence, index) =>
      index === 0
        ? sentence.replace(/\.$/, "")
        : sentence.replace(/^She /, "she ").replace(/\.$/, ""),
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
  const wardrobeIntents = intents.filter(
    (
      intent,
    ): intent is Extract<
      BeatIntent,
      { type: "removeGarment" | "addGarment" }
    > =>
      (intent.type === "removeGarment" || intent.type === "addGarment") &&
      // Replaying a removal for a garment already off morphs skin into the garment's shape.
      !isIntentSatisfied(intent, state),
  );
  const steps: string[] = [];
  if (wardrobeIntents.length > 0)
    steps.push(wardrobeSentence(wardrobeIntents, state));
  for (const intent of intents) {
    const sentence = intentSentence(intent, text, state);
    if (sentence) steps.push(sentence);
  }
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
