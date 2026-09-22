import { z } from "zod";
import { createGroqVisionCompletion, stripThinkBlock } from "@/lib/groq";
import type {
  FrameGuardReport,
  GarmentId,
  LiveState,
  ObservedState,
  Pose,
  Prop,
} from "../contract";
import { poseSchema } from "../contract";

// "unknown" covers occluded, cropped, layered-over, or otherwise not-judgeable — never coerced to
// present/absent, so an unjudgeable frame can't silently pass or fail a garment check.
const garmentPresenceSchema = z.enum(["present", "absent", "unknown"]);

const visionReportSchema = z.object({
  top: garmentPresenceSchema.optional(),
  bottom: garmentPresenceSchema.optional(),
  bra: garmentPresenceSchema.optional(),
  panties: garmentPresenceSchema.optional(),
  topColor: z.string().optional(),
  bottomColor: z.string().optional(),
  braColor: z.string().optional(),
  pantiesColor: z.string().optional(),
  visibleProps: z.array(z.string()).optional(),
  extraPeople: z.boolean().optional(),
  extraLimbs: z.boolean().optional(),
  // Raw model output; "unknown" or anything else unparseable is dropped by poseFromReport below.
  pose: z.string().optional(),
  // Identity check against the reference photo — face/hair/skin/build only. "unknown" never mismatches.
  sameWoman: z.enum(["yes", "no", "unknown"]).optional(),
});
type VisionReport = z.infer<typeof visionReportSchema>;

const VALID_POSES = new Set<string>(poseSchema.options);

// Only ever returns one of the seven valid poses; "unknown" and any garbage the model returns
// are dropped here so a bad read is never adopted as canon.
const poseFromReport = (report: VisionReport): Pose | undefined =>
  typeof report.pose === "string" && VALID_POSES.has(report.pose)
    ? (report.pose as Pose)
    : undefined;

const GUARD_PROMPT =
  "Look at these two images: the FIRST is the untouched original reference photo; the SECOND is a single frame " +
  "from an adult webcam stream that is supposed to show the same woman. Return ONLY JSON describing exactly " +
  'what is visible in the SECOND image: {"top":"present|absent|unknown","bottom":"present|absent|unknown",' +
  '"bra":"present|absent|unknown","panties":"present|absent|unknown","topColor":"...","bottomColor":"...",' +
  '"braColor":"...","pantiesColor":"...","visibleProps":["..."],"extraPeople":bool,"extraLimbs":bool,' +
  '"pose":"sitting|standing|leaning|kneeling|lying|onAllFours|bentOver|unknown","sameWoman":"yes|no|unknown"}. ' +
  'For top/bottom/bra/panties: "present" only if that garment is clearly worn; "absent" only if that body ' +
  'region is clearly visible and bare; "unknown" if it is occluded, cropped out of frame, covered by another ' +
  'layer, or otherwise not judgeable — never guess. For each garment that is "present", give its ONE main color ' +
  'as a single lowercase basic color word (e.g. "black", "red", "blue"), or "unknown" if the color is not ' +
  'clearly judgeable — never omit it. visibleProps lists any handheld object (e.g. "vibrator", "drink"), empty ' +
  "array if hands are empty. extraPeople is true only if more than one person is visible. extraLimbs is true " +
  "only if the body shows extra or malformed limbs. pose is her overall body position in the frame; use " +
  '"unknown" if it does not clearly match one of the other options. sameWoman compares the SECOND image to the ' +
  'FIRST: "yes" only if the face, hair, skin tone, and build clearly match the same person; "no" if they ' +
  'clearly do not; "unknown" if the face is not clearly visible in one or both images. Judge identity on face, ' +
  "hair, skin tone, and build only — ignore clothing, pose, nudity, and camera angle entirely.";

// Common garment colors, longest-first so "light blue" wins over a bare "blue" scan if ever extended.
const COLOR_WORDS = [
  "black",
  "white",
  "red",
  "pink",
  "purple",
  "blue",
  "green",
  "yellow",
  "orange",
  "brown",
  "beige",
  "nude",
  "gold",
  "silver",
  "grey",
  "gray",
];

const expectedColor = (description: string): string | null =>
  COLOR_WORDS.find((color) =>
    new RegExp(`\\b${color}\\b`, "i").test(description),
  ) ?? null;

const parseVisionReport = (raw: string): VisionReport | null => {
  const cleaned = stripThinkBlock(raw)
    .replace(/^```json\s*|\s*```$/g, "")
    .trim();
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  let json: unknown;
  try {
    json = JSON.parse(objectMatch?.[0] ?? cleaned);
  } catch {
    return null;
  }
  const parsed = visionReportSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
};

const GARMENT_SEEN: Record<GarmentId, keyof VisionReport> = {
  top: "top",
  bottom: "bottom",
  bra: "bra",
  panties: "panties",
};

const GARMENT_COLOR_SEEN: Record<GarmentId, keyof VisionReport> = {
  top: "topColor",
  bottom: "bottomColor",
  bra: "braColor",
  panties: "pantiesColor",
};

// Synonyms the vision model might use for a held prop (e.g. it says "toy" for a vibrator).
const PROP_SYNONYM: Partial<Record<Prop, RegExp>> = {
  vibrator: /vibrator|toy/i,
  dildo: /dildo|toy/i,
  drink: /drink|glass|cup|bottle/i,
  phone: /phone|mobile/i,
};

const matchesExpectedProp = (visible: string, expected: Prop): boolean =>
  (PROP_SYNONYM[expected] ?? new RegExp(expected, "i")).test(visible);

const compareToExpected = (
  report: VisionReport,
  expected: LiveState,
): string[] => {
  const issues: string[] = [];
  for (const id of Object.keys(GARMENT_SEEN) as GarmentId[]) {
    const reported = report[GARMENT_SEEN[id]];
    if (reported !== "present" && reported !== "absent") continue;
    const seen = reported === "present";
    const wanted = expected.wardrobe[id].on;
    if (wanted && !seen)
      issues.push(`${id} should be on but frame shows it off`);
    if (!wanted && seen)
      issues.push(`${id} should be off but frame shows it on`);

    if (wanted && seen) {
      const seenColor = report[GARMENT_COLOR_SEEN[id]];
      const wantedColor = expectedColor(expected.wardrobe[id].description);
      if (
        typeof seenColor === "string" &&
        seenColor &&
        seenColor.toLowerCase() !== "unknown" &&
        wantedColor &&
        seenColor.toLowerCase() !== wantedColor.toLowerCase()
      ) {
        issues.push(
          `${id} color drifted: expected ${wantedColor}, showing ${seenColor.toLowerCase()}`,
        );
      }
    }
  }

  const expectedProp = expected.body.prop;
  const visibleProps = report.visibleProps ?? [];
  if (expectedProp === "none" && visibleProps.length > 0) {
    issues.push(
      `unexpected object visible in hand: ${visibleProps.join(", ")}`,
    );
  }
  if (expectedProp !== "none" && expectedProp !== "fetching") {
    if (visibleProps.length === 0) {
      issues.push(`expected prop ${expectedProp} is not visible`);
    } else if (
      !visibleProps.some((visible) =>
        matchesExpectedProp(visible, expectedProp),
      )
    ) {
      issues.push(
        `wrong prop visible: ${visibleProps.join(", ")}, expected ${expectedProp}`,
      );
    }
  }
  if (report.extraPeople) issues.push("extra person visible in frame");
  if (report.extraLimbs) issues.push("extra or malformed limbs visible");
  // "unknown" never mismatches — only an explicit "no" is treated as identity drift.
  if (report.sameWoman === "no") {
    issues.push("identity drift: frame does not match the reference photo");
  }

  // Informational only — never matched by ANATOMY_ISSUE_RE or rejected on; the reconciled pose
  // (see generateClip.ts) is the actual fix.
  const observedPose = poseFromReport(report);
  if (observedPose && observedPose !== expected.body.pose) {
    issues.push(
      `pose drifted: expected ${expected.body.pose}, showing ${observedPose}`,
    );
  }
  return issues;
};

const observedWardrobeFrom = (
  report: VisionReport,
): ObservedState["wardrobe"] => {
  const wardrobe: ObservedState["wardrobe"] = {};
  for (const id of Object.keys(GARMENT_SEEN) as GarmentId[]) {
    const reported = report[GARMENT_SEEN[id]];
    if (reported === "present" || reported === "absent") {
      wardrobe[id] = reported === "present";
    }
  }
  return wardrobe;
};

export const guardFrame = async ({
  frameUrl,
  expected,
  anchorFrameUrl,
}: {
  frameUrl: string;
  expected: LiveState;
  // Untouched reference photo — compared against for the identity check (see GUARD_PROMPT).
  anchorFrameUrl: string;
}): Promise<
  Pick<FrameGuardReport, "checked" | "issues"> & {
    observed: ObservedState | null;
  }
> => {
  try {
    const completion = await createGroqVisionCompletion({
      imageUrl: frameUrl,
      referenceImageUrl: anchorFrameUrl,
      prompt: GUARD_PROMPT,
      responseFormat: { type: "json_object" },
    });
    const report = parseVisionReport(
      completion.choices[0]?.message?.content?.trim() ?? "",
    );
    if (!report) {
      console.warn(
        "guardFrame: vision model returned unparseable JSON, skipping check",
      );
      return { checked: false, issues: [], observed: null };
    }
    return {
      checked: true,
      issues: compareToExpected(report, expected).slice(0, 12),
      observed: {
        wardrobe: observedWardrobeFrom(report),
        pose: poseFromReport(report),
      },
    };
  } catch (error) {
    console.warn(
      "guardFrame: vision call failed or refused, skipping check",
      error,
    );
    return { checked: false, issues: [], observed: null };
  }
};
