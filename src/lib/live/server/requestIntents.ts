// The one request-understanding step for clip mode. Setup no longer picks a parser, so requests use the "hybrid" default: the LLM only reads what the regex catalogue could not place.
import type { BeatIntent, IntentParser, LiveState } from "../contract";
import { parseIntentsWithLlm } from "./parseIntents";
import {
  capIntents,
  dedupeConsecutiveIntents,
  resolveIntents,
} from "./planClip";

// The parse sits in front of the render; past this the regex intents stand rather than delay the reply further.
const INTENT_PARSE_BUDGET_MS = 2_500;

const hasCataloguedAction = (intents: BeatIntent[]): boolean =>
  intents.some(
    (intent) => intent.type !== "hold" && intent.type !== "verbatim",
  );

const withinBudget = <T>(promise: Promise<T>): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), INTENT_PARSE_BUDGET_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// Undefined keeps the regex catalogue: "regex" always, "hybrid" when it already found an action, and any LLM failure or timeout.
export const llmIntentsFor = async (
  text: string,
  state: LiveState,
  parser: IntentParser = "hybrid",
): Promise<BeatIntent[] | undefined> => {
  if (parser === "regex") return undefined;
  if (
    parser === "hybrid" &&
    hasCataloguedAction(resolveIntents(text, state.wardrobe, state.body))
  ) {
    return undefined;
  }
  const started = Date.now();
  const intents = await withinBudget(parseIntentsWithLlm(text, state)).catch(
    () => null,
  );
  console.log(
    `requestIntents: intentParser=${parser} ms=${Date.now() - started} intents=${intents ? JSON.stringify(intents) : "fallback"}`,
  );
  return intents ?? undefined;
};

// The intents planReply acts on for a request: the LLM's when it produced any, else the regex catalogue's.
export const requestIntentsFor = async (
  text: string,
  state: LiveState,
  parser: IntentParser = "hybrid",
): Promise<BeatIntent[]> => {
  const parsed = await llmIntentsFor(text, state, parser);
  return parsed && parsed.length > 0
    ? capIntents(dedupeConsecutiveIntents(parsed))
    : resolveIntents(text, state.wardrobe, state.body);
};
