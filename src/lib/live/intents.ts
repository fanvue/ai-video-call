// Framework-free helpers shared by the client director and the server planner. See contract.ts.

import type { BeatIntent, LiveState, Prop } from "./contract";

// Props that occupy a hand until she puts them down.
export const HELD_OBJECTS: ReadonlySet<Prop> = new Set([
  "vibrator",
  "dildo",
  "drink",
]);

// True when the intent's target state already holds; action-only intents are never "satisfied".
export const isIntentSatisfied = (
  intent: BeatIntent,
  state: Pick<LiveState, "wardrobe" | "body">,
): boolean => {
  switch (intent.type) {
    case "removeGarment":
      return !state.wardrobe[intent.garment].on;
    case "addGarment":
      return state.wardrobe[intent.garment].on;
    case "pose":
      return (
        state.body.pose === intent.pose && state.body.facing === intent.facing
      );
    case "framing":
      return state.body.framing === intent.framing;
    case "fetchProp":
      return state.body.prop === intent.prop;
    case "rest":
      return (
        state.body.prop === "none" &&
        state.body.contact === "none" &&
        (state.body.hands === "free" || state.body.hands === "typing")
      );
    case "useProp":
    case "touch":
    case "act":
    case "hold":
    case "verbatim":
      return false;
  }
};
