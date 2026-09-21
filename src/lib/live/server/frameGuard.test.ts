import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveState } from "../contract";
import { guardFrame, repairFrame } from "./frameGuard";

const createGroqVisionCompletion = vi.fn();
vi.mock("@/lib/groq", () => ({
  GROQ_VISION_MODEL: "test-vision-model",
  createGroqVisionCompletion: (...args: unknown[]) =>
    createGroqVisionCompletion(...args),
}));
const correctFrameIdentityDrift = vi.fn();
vi.mock("@/lib/fal/requestFrameIdentityCorrection", () => ({
  correctFrameIdentityDrift: (...args: unknown[]) =>
    correctFrameIdentityDrift(...args),
}));

const completionWith = (content: string) => ({
  choices: [{ message: { content } }],
});

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

beforeEach(() => {
  createGroqVisionCompletion.mockReset();
  correctFrameIdentityDrift.mockReset();
  correctFrameIdentityDrift.mockResolvedValue("https://x/repaired.jpg");
});

describe("guardFrame", () => {
  it("reports no issues when the frame matches expected state", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          topOn: true,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: [],
          extraPeople: false,
          extraLimbs: false,
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
    });
    expect(result.checked).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.observed).toEqual({
      wardrobe: { top: true, bottom: true, bra: true, panties: true },
    });
  });

  it("returns observed wardrobe booleans even when they disagree with expected", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          topOn: false,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: [],
          extraPeople: false,
          extraLimbs: false,
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
    });
    expect(result.observed?.wardrobe.top).toBe(false);
  });

  it("returns observed:null when the vision call fails or is unparseable", async () => {
    createGroqVisionCompletion.mockRejectedValue(new Error("refused"));
    const failed = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
    });
    expect(failed.observed).toBeNull();
  });

  it("flags a garment that drifted off when it should be on", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          topOn: false,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: [],
          extraPeople: false,
          extraLimbs: false,
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
    });
    expect(result.issues.some((issue) => issue.includes("top"))).toBe(true);
  });

  it("flags an unexpected object in her hand", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          topOn: true,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: ["phone"],
          extraPeople: false,
          extraLimbs: false,
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
    });
    expect(result.issues.some((issue) => issue.includes("phone"))).toBe(true);
  });

  it("flags extra people and extra limbs", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          topOn: true,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: [],
          extraPeople: true,
          extraLimbs: true,
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
    });
    expect(result.issues.some((i) => i.includes("extra person"))).toBe(true);
    expect(
      result.issues.some((i) => i.includes("extra or malformed limbs")),
    ).toBe(true);
  });

  it("returns unchecked rather than repairing blind when the vision call fails", async () => {
    createGroqVisionCompletion.mockRejectedValue(new Error("refused"));
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
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
    });
    expect(result.checked).toBe(false);
  });

  it("flags the wrong prop when a different object is visible instead of the expected one", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          topOn: true,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: ["drink"],
          extraPeople: false,
          extraLimbs: false,
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected: expectedWithProp("vibrator"),
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
      completionWith(
        JSON.stringify({
          topOn: true,
          topColor: "red",
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: [],
          extraPeople: false,
          extraLimbs: false,
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
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
      completionWith(
        JSON.stringify({
          topOn: true,
          topColor: "Black",
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: [],
          extraPeople: false,
          extraLimbs: false,
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
    });
    expect(result.issues).toEqual([]);
  });

  it("parses a valid pose into observed.pose", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          topOn: true,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: [],
          extraPeople: false,
          extraLimbs: false,
          pose: "standing",
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
    });
    expect(result.observed?.pose).toBe("standing");
  });

  it("drops an unknown/unparseable pose rather than adopting it", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          topOn: true,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: [],
          extraPeople: false,
          extraLimbs: false,
          pose: "unknown",
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
    });
    expect(result.observed?.pose).toBeUndefined();
  });

  it("flags pose drift as informational only, never triggering repair", async () => {
    createGroqVisionCompletion.mockResolvedValue(
      completionWith(
        JSON.stringify({
          topOn: true,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: [],
          extraPeople: false,
          extraLimbs: false,
          pose: "standing",
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected,
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
      completionWith(
        JSON.stringify({
          topOn: true,
          bottomOn: true,
          braOn: true,
          pantiesOn: true,
          visibleProps: ["toy"],
          extraPeople: false,
          extraLimbs: false,
        }),
      ),
    );
    const result = await guardFrame({
      frameUrl: "https://x/frame.jpg",
      expected: expectedWithProp("vibrator"),
    });
    expect(result.issues).toEqual([]);
  });
});

describe("repairFrame instructions", () => {
  it("asks to add the missing prop back into her hand", async () => {
    await repairFrame({
      frameUrl: "https://x/frame.jpg",
      anchorFrameUrl: "https://x/anchor.jpg",
      expected: expectedWithProp("vibrator"),
      issues: ["expected prop vibrator is not visible"],
    });
    const call = correctFrameIdentityDrift.mock.calls[0]?.[0] as {
      prompt: string;
    };
    expect(call.prompt).toMatch(
      /add the vibrator back into her hand, same pose, framing and background/i,
    );
  });

  it("asks to replace the wrong prop with the expected one", async () => {
    await repairFrame({
      frameUrl: "https://x/frame.jpg",
      anchorFrameUrl: "https://x/anchor.jpg",
      expected: expectedWithProp("vibrator"),
      issues: ["wrong prop visible: drink, expected vibrator"],
    });
    const call = correctFrameIdentityDrift.mock.calls[0]?.[0] as {
      prompt: string;
    };
    expect(call.prompt).toMatch(
      /replace the drink in her hand with the vibrator/i,
    );
  });

  it("asks to correct a garment's color back to its described color", async () => {
    await repairFrame({
      frameUrl: "https://x/frame.jpg",
      anchorFrameUrl: "https://x/anchor.jpg",
      expected,
      issues: ["top color drifted: expected black, showing red"],
    });
    const call = correctFrameIdentityDrift.mock.calls[0]?.[0] as {
      prompt: string;
    };
    expect(call.prompt).toMatch(
      /correct her top back to its original color: black tank top/i,
    );
  });
});
