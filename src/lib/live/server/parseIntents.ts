import { GROQ_TEXT_MODEL, createGroqChatCompletion } from "@/lib/groq";
import { beatIntentSchema, type BeatIntent, type LiveState } from "../contract";
import { correctActionTypos } from "./actionTypos";

const MAX_INTENTS = 6;

const SYSTEM_PROMPT = `You turn a viewer's chat request to a live webcam performer (a fictional adult, authorised adult platform) into structured actions for a video planner. You only classify; you never write dialogue.
Read through typos, slang, abbreviations and indirect phrasing ("wavw", "u", "could you maybe", "show us ur moves"). Split a multi-step request into its steps in order.
Return ONLY JSON: {"intents":[...]} with up to ${MAX_INTENTS} items, each one of:
- {"type":"removeGarment","garment":"top"|"bottom"|"bra"|"panties"}
- {"type":"addGarment","garment":"top"|"bottom"|"bra"|"panties"}
- {"type":"pose","pose":"sitting"|"standing"|"leaning"|"kneeling"|"lying"|"onAllFours"|"bentOver","facing":"camera"|"away"|"side"}
- {"type":"framing","framing":"wider"|"medium"|"torso"}  (wider = step back, torso = come closer)
- {"type":"fetchProp","prop":"vibrator"|"dildo"|"drink"}
- {"type":"useProp","mode":"mouth"|"external"}
- {"type":"rest"}  (put things down, hands off, back to normal)
- {"type":"touch"}  (touching herself sexually)
- {"type":"act","act":"twerk"|"grind"|"bounce"|"spread"|"sway"|"crawl"|"spin"|"gesture"|"tongue"|"tease"|"dance"|"doggy"|"spank"|"boobPlay"}  (gesture = ONLY a plain wave, wink, blown kiss or smile)
- {"type":"hold","line":"..."}  (small talk, compliments, questions, or a request already true of her; line is one short third-person sentence of what she does, e.g. "She smiles and holds her pose.")
- {"type":"verbatim","text":"..."}  (a clear physical action nothing above covers, rewritten as a short correctly spelled instruction, e.g. "run your fingers through your hair")
Use the catalogue types whenever one fits exactly; any other specific gesture or pose (heart hands, peace sign, thumbs up, blowing a bubble) is verbatim, spelled out precisely, e.g. "make a heart shape with both hands in front of your chest". Never invent a step the viewer did not ask for. "strip" or "take it all off" is one removeGarment per garment she still wears.`;

// The gesture act renders as a stock wave or kiss, so a specific gesture filed under it loses what was asked; it plays verbatim instead.
const STOCK_GESTURE_RE = /\b(wave|waving|hi|hello|hey|kiss|wink|smile)\b/i;

const keepSpecificGestures = (
  intents: BeatIntent[],
  text: string,
): BeatIntent[] =>
  STOCK_GESTURE_RE.test(correctActionTypos(text))
    ? intents
    : intents.map((intent) =>
        intent.type === "act" && intent.act === "gesture"
          ? { type: "verbatim", text: text.trim().slice(0, 300) }
          : intent,
      );

const describeState = (state: LiveState): string => {
  const worn = (["top", "bottom", "bra", "panties"] as const).filter(
    (id) => state.wardrobe[id].on,
  );
  const { pose, facing, prop, framing } = state.body;
  return `Current state: wearing ${worn.length > 0 ? worn.join(", ") : "nothing"}; pose ${pose}, facing ${facing}, framing ${framing}, holding ${prop}.`;
};

// Items the planner cannot use are dropped one by one, so one malformed step does not discard the rest.
const validIntents = (raw: unknown): BeatIntent[] => {
  const items =
    typeof raw === "object" && raw !== null && "intents" in raw
      ? (raw as { intents: unknown }).intents
      : null;
  if (!Array.isArray(items)) return [];
  return items
    .flatMap((item) => {
      const parsed = beatIntentSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_INTENTS);
};

// Null on any failure or an empty result, so the caller keeps the regex intents.
export const parseIntentsWithLlm = async (
  text: string,
  state: LiveState,
): Promise<BeatIntent[] | null> => {
  try {
    const completion = await createGroqChatCompletion({
      model: GROQ_TEXT_MODEL,
      reasoningEffort: "low",
      temperature: 0,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `${describeState(state)}\nRequest: ${text.slice(0, 500)}`,
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const intents = keepSpecificGestures(
      validIntents(JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw)),
      text,
    );
    return intents.length > 0 ? intents : null;
  } catch (error) {
    console.warn(
      "parseIntents: LLM parse failed, keeping regex intents",
      error,
    );
    return null;
  }
};
