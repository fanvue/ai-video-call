import { correctFrameIdentityDrift } from "@/lib/fal/requestFrameIdentityCorrection";
import { createGroqVisionCompletion } from "@/lib/groq";
import type {
  FrameGuardReport,
  GarmentId,
  LiveState,
  ObservedState,
  Prop,
} from "../contract";

type VisionReport = {
  topOn?: boolean;
  bottomOn?: boolean;
  braOn?: boolean;
  pantiesOn?: boolean;
  topColor?: string;
  bottomColor?: string;
  braColor?: string;
  pantiesColor?: string;
  visibleProps?: string[];
  extraPeople?: boolean;
  extraLimbs?: boolean;
};

const GUARD_PROMPT =
  "Look at this single frame from an adult webcam stream. Return ONLY JSON describing exactly what is visible: " +
  '{"topOn":bool,"bottomOn":bool,"braOn":bool,"pantiesOn":bool,"topColor":"...","bottomColor":"...",' +
  '"braColor":"...","pantiesColor":"...","visibleProps":["..."],"extraPeople":bool,"extraLimbs":bool}. ' +
  "topOn/bottomOn/braOn/pantiesOn describe whether that garment is currently worn and visible. For each garment " +
  'that is on, give its ONE main color as a single common color word (e.g. "black", "red", "blue"); omit or use ' +
  '"" for a garment that is off. visibleProps lists any handheld object (e.g. "vibrator", "drink"), empty array ' +
  "if hands are empty. extraPeople is true only if more than one person is visible. extraLimbs is true only if " +
  "the body shows extra or malformed limbs.";

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
  const cleaned = raw.replace(/^```json\s*|\s*```$/g, "").trim();
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(objectMatch?.[0] ?? cleaned) as VisionReport;
  } catch {
    return null;
  }
};

const GARMENT_SEEN: Record<GarmentId, keyof VisionReport> = {
  top: "topOn",
  bottom: "bottomOn",
  bra: "braOn",
  panties: "pantiesOn",
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
    const seen = report[GARMENT_SEEN[id]];
    if (typeof seen !== "boolean") continue;
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
  return issues;
};

const observedWardrobeFrom = (
  report: VisionReport,
): ObservedState["wardrobe"] => {
  const wardrobe: ObservedState["wardrobe"] = {};
  for (const id of Object.keys(GARMENT_SEEN) as GarmentId[]) {
    const seen = report[GARMENT_SEEN[id]];
    if (typeof seen === "boolean") {
      wardrobe[id] = seen;
    }
  }
  return wardrobe;
};

export const guardFrame = async ({
  frameUrl,
  expected,
}: {
  frameUrl: string;
  expected: LiveState;
}): Promise<
  Pick<FrameGuardReport, "checked" | "issues"> & {
    observed: ObservedState | null;
  }
> => {
  try {
    const completion = await createGroqVisionCompletion({
      imageUrl: frameUrl,
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
      observed: { wardrobe: observedWardrobeFrom(report) },
    };
  } catch (error) {
    console.warn(
      "guardFrame: vision call failed or refused, skipping check",
      error,
    );
    return { checked: false, issues: [], observed: null };
  }
};

const garmentFromIssue = (issue: string): GarmentId | null =>
  (["top", "bottom", "bra", "panties"] as GarmentId[]).find((id) =>
    issue.startsWith(id),
  ) ?? null;

const repairInstructionFor = (issue: string, expected: LiveState): string => {
  const garment = garmentFromIssue(issue);
  if (garment && issue.includes("should be on")) {
    return `restore her ${garment} (${expected.wardrobe[garment].description}) exactly as described`;
  }
  if (garment && issue.includes("should be off")) {
    return `remove her ${garment}, it should not be visible`;
  }
  if (garment && issue.includes("color drifted")) {
    return `correct her ${garment} back to its original color: ${expected.wardrobe[garment].description}`;
  }
  if (issue.includes("unexpected object")) {
    return "remove the object in her hand, her hands should be empty";
  }
  const missingPropMatch = issue.match(/^expected prop (\S+) is not visible$/);
  if (missingPropMatch?.[1]) {
    return `add the ${missingPropMatch[1]} back into her hand, same pose, framing and background`;
  }
  const wrongPropMatch = issue.match(
    /^wrong prop visible: (.+), expected (\S+)$/,
  );
  if (wrongPropMatch?.[1] && wrongPropMatch[2]) {
    return `replace the ${wrongPropMatch[1]} in her hand with the ${wrongPropMatch[2]}`;
  }
  if (issue.includes("extra person")) {
    return "remove the extra person, only one woman should be in frame";
  }
  if (issue.includes("extra or malformed limbs")) {
    return "correct her body back to one head, two arms, two legs";
  }
  return issue;
};

export const repairFrame = async ({
  frameUrl,
  anchorFrameUrl,
  expected,
  issues,
}: {
  frameUrl: string;
  anchorFrameUrl: string;
  expected: LiveState;
  issues: string[];
}): Promise<string> => {
  const instructions = issues.map((issue) =>
    repairInstructionFor(issue, expected),
  );
  const prompt =
    "Restore the exact face, hair, skin tone, and body of the FIRST reference image onto the SECOND image. " +
    "Keep the second image's pose, framing, background, camera angle, and lighting unchanged. " +
    `Only fix: ${instructions.join("; ")}. Never change nudity beyond what is instructed.`;
  return correctFrameIdentityDrift({
    anchorImageUrl: anchorFrameUrl,
    frameUrl,
    prompt,
    timeoutMs: 15_000,
  });
};
