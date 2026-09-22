import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({ env: { GROQ_API_KEY: "test-key" } }));

const create = vi.fn();
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

const { GROQ_VISION_MODELS, createGroqVisionCompletion, stripThinkBlock } =
  await import("./groq");

describe("stripThinkBlock", () => {
  it("drops a leading reasoning block so its braces cannot hijack the JSON match", () => {
    expect(
      stripThinkBlock(
        '<think>maybe {"framing":"wider"}?</think>\n{"framing":"torso"}',
      ),
    ).toBe('{"framing":"torso"}');
  });

  it("leaves plain content untouched", () => {
    expect(stripThinkBlock('{"a":1}')).toBe('{"a":1}');
  });
});

describe("createGroqVisionCompletion", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ choices: [{ message: { content: "{}" } }] });
  });

  it("uses the Qwen3 vision model with its reasoning hidden", async () => {
    expect(GROQ_VISION_MODELS).toEqual(["qwen/qwen3.8-27b"]);
    await createGroqVisionCompletion({
      imageUrl: "https://example.com/frame.jpg",
      prompt: "describe",
      responseFormat: { type: "json_object" },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "qwen/qwen3.8-27b",
        reasoning_format: "hidden",
        response_format: { type: "json_object" },
      }),
    );
  });

  it("does not send reasoning_format to a non-reasoning model", async () => {
    await createGroqVisionCompletion({
      model: "some/other-vision-model",
      imageUrl: "https://example.com/frame.jpg",
      prompt: "describe",
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("reasoning_format");
  });
});
