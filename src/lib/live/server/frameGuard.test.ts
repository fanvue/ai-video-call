import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { LiveState } from "../contract";
import { guardFrame } from "./frameGuard";

const createGroqVisionCompletion = vi.fn();
vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/lib/groq", async (importOriginal) => ({
  stripThinkBlock: (await importOriginal<typeof import("@/lib/groq")>())
    .stripThinkBlock,
  GROQ_VISION_MODEL: "test-vision-model",
  createGroqVisionCompletion: (...args: unknown[]) =>
    createGroqVisionCompletion(...args),
}));

const completionWith = (content: string) => ({
  choices: [{ message: { content } }],
});

const ANCHOR_URL = "https://x/anchor.jpg";

const expected: LiveState = {
  wardrobe: {
    top: { on: true, description: "black tank top" },
    bottom: { on: true, description: "denim shorts" },
    bra: { on: true, description: "black bra" },
    panties: { on: true, description: "black panties" },
    removedOrder: [],
  },
  body: {
    pose: "sitting",
    facing: "camera",
    hands: "free",
    contact: "none",
    prop: "none",
    framing: "wider",
  },
  baselineBody: {
    pose: "sitting",
    facing: "camera",
    hands: "free",
    contact: "none",
    prop: "none",
    framing: "wider",
  },
  world: "w",
  surroundings: "bedroom",
};

const expectedWithProp = (prop: LiveState["body"]["prop"]): LiveState => ({
  ...expected,
  body: { ...expected.body, prop },
});

const fullReport = (overrides: Record<string, unknown> = {}) => ({
  top: "present",
  bottom: "present",
  bra: "present",
  panties: "present",
  visibleProps: [],
  extraPeople: false,
  extraLimbs: false,
  sameWoman: "yes",
  ...overrides,
});

beforeEach(() => {
  createGroqVisionCompletion.mockReset();
});

describe("guardFrame", () => {
  it("reports no issues when the frame matches expected state", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport())),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.checked).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.observed).toEqual({
      wardrobe: { top: true, bottom: true, bra: true, panties: true },
    });
  });

  it("parses the report after a Qwen3 <think> block", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        `<think>top looks {"top":"absent"} maybe</think>\n${JSON.stringify(fullReport())}`,
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.checked).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("sends the anchor frame as a reference image ahead of the checked frame", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport())),
    );
    await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(createGroqVisionCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: "https://x/frame.jpg",
        referenceImageUrl: ANCHOR_URL,
      }),
    );
  });

  it("returns observed wardrobe booleans even when they disagree with expected", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ top: "absent" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.observed?.wardrobe.top).toBe(false);
  });

  it("does not report a garment observed as unknown, and omits it from observed.wardrobe", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ bra: "unknown" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues.some((issue) => issue.includes("bra"))).toBe(false);
    expect(result.observed?.wardrobe.bra).toBeUndefined();
  });

  it("returns observed:null when the vision call fails or is unparseable", async () => {
    createGroqVisionCompletion.mockRejectedValue(new Error("refused"));
    const failed = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(failed.observed).toBeNull();
  });

  it("flags a garment that drifted off when it should be on", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ top: "absent" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues.some((issue) => issue.includes("top"))).toBe(true);
  });

  it("flags an unexpected object in her hand", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ visibleProps: ["phone"] }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues.some((issue) => issue.includes("phone"))).toBe(true);
  });

  it("flags extra people and extra limbs", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify(fullReport({ extraPeople: true, extraLimbs: true })),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues.some((i) => i.includes("extra person"))).toBe(true);
    expect(
      result.issues.some((i) => i.includes("extra or malformed limbs")),
    ).toBe(true);
  });

  it("returns unchecked rather than guessing when the vision call fails", async () => {
    createGroqVisionCompletion.mockRejectedValue(new Error("refused"));
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.checked).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it("returns unchecked when the model returns unparseable JSON", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith("not json at all"),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.checked).toBe(false);
  });

  it("returns unchecked when a field fails schema validation instead of crashing", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ extraPeople: "yes" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.checked).toBe(false);
    expect(result.observed).toBeNull();
  });

  it("returns unchecked when a garment field is a value outside present/absent/unknown", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ top: "maybe" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.checked).toBe(false);
  });

  it("flags the wrong prop when a different object is visible instead of the expected one", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ visibleProps: ["drink"] }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected: expectedWithProp("vibrator"),
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.includes("wrong prop visible") &&
          issue.includes("drink") &&
          issue.includes("vibrator"),
      ),
    ).toBe(true);
  });

  it("flags a garment whose color drifted even though it is still on", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ topColor: "red" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.includes("top color drifted") &&
          issue.includes("expected black") &&
          issue.includes("showing red"),
      ),
    ).toBe(true);
  });

  it("does not flag color when it matches expected", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ topColor: "Black" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues).toEqual([]);
  });

  it('does not flag color drift when the observed color is "unknown"', async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ topColor: "unknown" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues.some((issue) => issue.includes("color"))).toBe(false);
  });

  it("parses a valid pose into observed.pose", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ pose: "standing" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.observed?.pose).toBe("standing");
  });

  it("drops an unknown/unparseable pose rather than adopting it", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ pose: "unknown" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.observed?.pose).toBeUndefined();
  });

  it("flags pose drift as informational only", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ pose: "standing" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues.some((issue) => issue.includes("pose drifted"))).toBe(
      true,
    );
    expect(
      result.issues.some((issue) =>
        /extra person|extra or malformed limbs/.test(issue),
      ),
    ).toBe(false);
  });

  it("does not flag a synonym for the expected prop as wrong", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ visibleProps: ["toy"] }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected: expectedWithProp("vibrator"),
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues).toEqual([]);
  });

  it("flags identity drift when sameWoman is no", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ sameWoman: "no" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(
      result.issues.some((issue) => issue.includes("identity drift")),
    ).toBe(true);
  });

  it("does not flag identity drift when sameWoman is unknown", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ sameWoman: "unknown" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues.some((issue) => issue.includes("identity"))).toBe(
      false,
    );
  });

  it("does not flag identity drift when sameWoman is yes", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(JSON.stringify(fullReport({ sameWoman: "yes" }))),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
      anchorFrameUrl: ANCHOR_URL,
    });
    expect(result.issues.some((issue) => issue.includes("identity"))).toBe(
      false,
    );
  });
});
