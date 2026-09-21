// State follows the frame, but only in the direction the request asked for — drift against that
// direction is corrected by the next clip's own NOW line, not adopted, or it becomes permanent
// canon. Exception: the beat's own target garment always follows observation either way, since
// director.ts's bounded retry checks it against `result.state` to decide whether to re-attempt.
// Pose (reconcilePose below) is reconciled unconditionally — a stale pose in canon is what makes
// the model "fix" the seed/prompt contradiction by moving again.
import type {
  Body,
  GarmentId,
  ObservedState,
  Pose,
  Wardrobe,
} from "../contract";

const GARMENT_IDS: GarmentId[] = ["top", "bottom", "bra", "panties"];

export const reconcileWardrobe = (
  expected: Wardrobe,
  observed: ObservedState["wardrobe"],
  direction: "remove" | "add" | null,
  targetGarment?: GarmentId,
): Wardrobe => {
  let wardrobe = expected;
  for (const id of GARMENT_IDS) {
    const seen = observed[id];
    if (typeof seen !== "boolean" || seen === wardrobe[id].on) {
      continue;
    }
    const adopt =
      id === targetGarment ||
      (direction === "remove" && seen === false) ||
      (direction === "add" && seen === true);
    if (!adopt) {
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

export const reconcilePose = (expected: Body, observedPose?: Pose): Body =>
  observedPose && observedPose !== expected.pose
    ? { ...expected, pose: observedPose }
    : expected;
