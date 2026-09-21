// State follows the frame: the guard's observation of wardrobe overrides prediction. Props are not
// reconciled here (vision misses small toys) — see generateClip.ts.
import type { GarmentId, ObservedState, Wardrobe } from "../contract";

const GARMENT_IDS: GarmentId[] = ["top", "bottom", "bra", "panties"];

export const reconcileWardrobe = (
  expected: Wardrobe,
  observed: ObservedState["wardrobe"],
): Wardrobe => {
  let wardrobe = expected;
  for (const id of GARMENT_IDS) {
    const seen = observed[id];
    if (typeof seen !== "boolean" || seen === wardrobe[id].on) {
      continue;
    }
    wardrobe = {
      ...wardrobe,
      [id]: { ...wardrobe[id], on: seen },
      removedOrder: seen
        ? wardrobe.removedOrder.filter((garment) => garment !== id)
        : wardrobe.removedOrder.includes(id)
          ? wardrobe.removedOrder
          : [...wardrobe.removedOrder, id],
    };
  }
  return wardrobe;
};
