import { correctFrameIdentityDrift } from "@/lib/fal/requestFrameIdentityCorrection";
import { createGroqVisionCompletion } from "@/lib/groq";
import type { FrameGuardReport, GarmentId, LiveState } from "../contract";

type VisionReport = {
  topOn?: boolean;
  bottomOn?: boolean;
  braOn?: boolean;
  pantiesOn?: boolean;
  visibleProps?: string[];
  extraPeople?: boolean;
  extraLimbs?: boolean;
};

const GUARD_PROMPT =
  "Look at this single frame from an adult webcam stream. Return ONLY JSON describing exactly what is visible: " +
  '{"topOn":bool,"bottomOn":bool,"braOn":bool,"pantiesOn":bool,"visibleProps":["..."],"extraPeople":bool,"extraLimbs":bool}. ' +
  "topOn/bottomOn/braOn/pantiesOn describe whether that garment is currently worn and visible. visibleProps lists any " +
  'handheld object (e.g. "vibrator", "drink"), empty array if hands are empty. extraPeople is true only if more than ' +
  "one person is visible. extraLimbs is true only if the body shows extra or malformed limbs.";

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
  }

  const expectedProp = expected.body.prop;
  const visibleProps = report.visibleProps ?? [];
  if (expectedProp === "none" && visibleProps.length > 0) {
    issues.push(
      `unexpected object visible in hand: ${visibleProps.join(", ")}`,
    );
  }
  if (
    expectedProp !== "none" &&
    expectedProp !== "fetching" &&
    visibleProps.length === 0
  ) {
    issues.push(`expected prop ${expectedProp} is not visible`);
  }
  if (report.extraPeople) issues.push("extra person visible in frame");
  if (report.extraLimbs) issues.push("extra or malformed limbs visible");
  return issues;
};

export const guardFrame = async ({
  frameUrl,
  expected,
}: {
  frameUrl: string;
  expected: LiveState;
}): Promise<Pick<FrameGuardReport, "checked" | "issues">> => {
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
      return { checked: false, issues: [] };
    }
    return {
      checked: true,
      issues: compareToExpected(report, expected).slice(0, 12),
    };
  } catch (error) {
    console.warn(
      "guardFrame: vision call failed or refused, skipping check",
      error,
    );
    return { checked: false, issues: [] };
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
  if (issue.includes("unexpected object")) {
    return "remove the object in her hand, her hands should be empty";
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
