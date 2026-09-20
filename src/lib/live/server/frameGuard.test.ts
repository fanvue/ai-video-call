import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveState } from "../contract";
import { guardFrame } from "./frameGuard";

const createGroqVisionCompletion = vi.fn();
vi.mock("@/lib/groq", () => ({
  GROQ_VISION_MODEL: "test-vision-model",
  createGroqVisionCompletion: (...args: unknown[]) =>
    createGroqVisionCompletion(...args),
}));
vi.mock("@/lib/fal/requestFrameIdentityCorrection", () => ({
  correctFrameIdentityDrift: vi.fn(),
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

beforeEach(() => {
  createGroqVisionCompletion.mockReset();
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
});
