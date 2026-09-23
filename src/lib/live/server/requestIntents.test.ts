import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveState } from "../contract";

const parseIntentsWithLlm = vi.fn();
vi.mock("./parseIntents", () => ({
  parseIntentsWithLlm: (...args: unknown[]) => parseIntentsWithLlm(...args),
}));

const { llmIntentsFor } = await import("./requestIntents");

const body = {
  pose: "sitting",
  facing: "camera",
  hands: "free",
  contact: "none",
  prop: "none",
  framing: "medium",
} as const;

const state = {
  wardrobe: {
    top: { on: true, description: "top" },
    bottom: { on: true, description: "bottoms" },
    bra: { on: true, description: "white bra" },
    panties: { on: true, description: "white panties" },
    removedOrder: [],
  },
  body,
  baselineBody: body,
  world: "",
  surroundings: "a bedroom",
} as LiveState;

beforeEach(() => {
  parseIntentsWithLlm.mockReset();
  parseIntentsWithLlm.mockResolvedValue([{ type: "wave" }]);
});

describe("llmIntentsFor default parser", () => {
  it("asks the LLM when the regex catalogue finds no action", async () => {
    await expect(
      llmIntentsFor("do that thing you did earlier again", state),
    ).resolves.toEqual([{ type: "wave" }]);
    expect(parseIntentsWithLlm).toHaveBeenCalledOnce();
  });

  it("keeps the regex catalogue when it already found an action", async () => {
    await expect(llmIntentsFor("wave at me", state)).resolves.toBeUndefined();
    expect(parseIntentsWithLlm).not.toHaveBeenCalled();
  });

  it("falls back to the regex catalogue when the LLM fails", async () => {
    parseIntentsWithLlm.mockRejectedValue(new Error("groq down"));
    await expect(
      llmIntentsFor("do that thing you did earlier again", state),
    ).resolves.toBeUndefined();
  });
});
