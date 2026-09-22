import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveState } from "../contract";

const create = vi.fn();
vi.mock("@/lib/groq", () => ({
  GROQ_TEXT_MODEL: "test-model",
  createGroqChatCompletion: (...args: unknown[]) => create(...args),
}));

const { parseIntentsWithLlm } = await import("./parseIntents");

const state = {
  wardrobe: {
    top: { on: false, description: "top" },
    bottom: { on: false, description: "bottoms" },
    bra: { on: true, description: "white bra" },
    panties: { on: true, description: "white panties" },
    removedOrder: [],
  },
  body: {
    pose: "sitting",
    facing: "camera",
    hands: "free",
    contact: "none",
    prop: "none",
    framing: "medium",
  },
  baselineBody: {
    pose: "sitting",
    facing: "camera",
    hands: "free",
    contact: "none",
    prop: "none",
    framing: "medium",
  },
  world: "",
  surroundings: "a bedroom",
} as LiveState;

const reply = (content: string) => ({
  choices: [{ message: { content } }],
});

describe("parseIntentsWithLlm", () => {
  beforeEach(() => create.mockReset());

  it("keeps the valid intents and drops malformed ones", async () => {
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          intents: [
            { type: "act", act: "gesture" },
            { type: "act", act: "moonwalk" },
            { type: "verbatim", text: "run your fingers through your hair" },
          ],
        }),
      ),
    );
    await expect(
      parseIntentsWithLlm("wavw then play w ur hair", state),
    ).resolves.toEqual([
      { type: "act", act: "gesture" },
      { type: "verbatim", text: "run your fingers through your hair" },
    ]);
    const [{ messages }] = create.mock.calls[0] as [
      { messages: { content: string }[] },
    ];
    expect(messages[1]?.content).toMatch(/wearing bra, panties; pose sitting/);
  });

  it("plays a specific gesture filed as the stock gesture act verbatim", async () => {
    create.mockResolvedValue(
      reply(JSON.stringify({ intents: [{ type: "act", act: "gesture" }] })),
    );
    await expect(
      parseIntentsWithLlm("do a heart with ur hands", state),
    ).resolves.toEqual([
      { type: "verbatim", text: "do a heart with ur hands" },
    ]);
  });

  it("returns null on an empty, unparseable or failed response", async () => {
    create.mockResolvedValueOnce(reply('{"intents":[]}'));
    await expect(parseIntentsWithLlm("hm", state)).resolves.toBeNull();
    create.mockResolvedValueOnce(reply("not json"));
    await expect(parseIntentsWithLlm("hm", state)).resolves.toBeNull();
    create.mockRejectedValueOnce(new Error("429"));
    await expect(parseIntentsWithLlm("hm", state)).resolves.toBeNull();
  });
});
