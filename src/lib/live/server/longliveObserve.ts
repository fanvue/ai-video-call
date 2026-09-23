// LongLive has no clip to guard, so a wardrobe change is confirmed on a frame of the live stream before prompts assert it.
import type { CreatorProfile, GarmentId, LiveState } from "../contract";
import { guardFrame } from "./frameGuard";
import { planLongLiveSettle } from "./longlivePrompt";
import { reconcileWardrobe } from "./reconcileState";

// generateClip's guard budget; past it the change counts as unconfirmed rather than hold the stream's settle.
const OBSERVE_BUDGET_MS = 8_000;

export type LongLiveObservation = {
  confirmed: boolean;
  state: LiveState;
  // The settle scene naming what she now wears; only once the change is confirmed.
  settlePrompt: string | null;
};

const withinBudget = <T>(promise: Promise<T>): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), OBSERVE_BUDGET_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export const observeLongLiveWardrobe = async (input: {
  creator: CreatorProfile;
  // The state the request was planned to leave her in.
  expected: LiveState;
  garments: GarmentId[];
  frameUrl: string;
  referenceImageUrl: string;
}): Promise<LongLiveObservation> => {
  const { creator, expected, garments } = input;
  const unconfirmed = { confirmed: false, state: expected, settlePrompt: null };
  const check = await withinBudget(
    guardFrame({
      frameUrl: input.frameUrl,
      expected,
      anchorFrameUrl: input.referenceImageUrl,
    }),
  );
  if (!check?.checked || !check.observed) return unconfirmed;
  const seen = check.observed.wardrobe;
  // "unknown" leaves a garment out of `seen`, so an occluded or cropped garment never confirms.
  const confirmed =
    garments.length > 0 &&
    garments.every((id) => seen[id] === expected.wardrobe[id].on);
  const wardrobe = garments.reduce(
    (current, id) => reconcileWardrobe(current, seen, id),
    expected.wardrobe,
  );
  const state = { ...expected, wardrobe };
  return {
    confirmed,
    state,
    settlePrompt: confirmed ? planLongLiveSettle(creator, state, true) : null,
  };
};
