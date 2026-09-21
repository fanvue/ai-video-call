// Only the beat's own target garment is reconciled: generateClip.ts rejects any other mismatch, so canon already agrees; the target always follows observation either way for director.ts's bounded retry.
// Pose is reconciled unconditionally, or a stale canon pose makes the model "fix" the seed/prompt contradiction by moving again.
import type {
  Body,
  GarmentId,
  ObservedState,
  Pose,
  Wardrobe,
} from "../contract";

export const reconcileWardrobe = (
  expected: Wardrobe,
  observed: ObservedState["wardrobe"],
  targetGarment?: GarmentId,
): Wardrobe => {
  if (!targetGarment) return expected;
  const seen = observed[targetGarment];
  if (typeof seen !== "boolean" || seen === expected[targetGarment].on) {
    return expected;
  }
  return {
    ...expected,
    [targetGarment]: { ...expected[targetGarment], on: seen },
    removedOrder: seen
      ? expected.removedOrder.filter((garment) => garment !== targetGarment)
      : expected.removedOrder.includes(targetGarment)
        ? expected.removedOrder
        : [...expected.removedOrder, targetGarment],
  };
};

export const reconcilePose = (expected: Body, observedPose?: Pose): Body =>
  observedPose && observedPose !== expected.pose
    ? { ...expected, pose: observedPose }
    : expected;
