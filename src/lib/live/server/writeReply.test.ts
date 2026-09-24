import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorProfile, TranscriptEntry } from "../contract";
import {
  clampSpokenLine,
  isRefusal,
  isTooSimilarToPrior,
  writeCheckIn,
  writeReply,
} from "./writeReply";

const createGroqChatCompletion = vi.fn();
vi.mock("@/lib/groq", () => ({
  GROQ_TEXT_MODEL: "test-model",
  createGroqChatCompletion: (...args: unknown[]) =>
    createGroqChatCompletion(...args),
}));

const creator: CreatorProfile = {
  id: "c1",
  displayName: "Aria",
  lookLock: "dark hair",
  sceneId: "bedroom",
  tipMenu: [],
};

const completionWith = (content: string) => ({
  choices: [{ message: { content } }],
});

beforeEach(() => {
  createGroqChatCompletion.mockReset();
});

describe("clampSpokenLine", () => {
  it("strips control characters and em dashes, keeping the source text-safe", () => {
    expect(clampSpokenLine("hi\x01there — mmm")).toBe("hi there , mmm");
  });

  it("caps to 40 words and 280 characters", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const result = clampSpokenLine(long);
    expect(result.split(" ").length).toBeLessThanOrEqual(40);
    expect(result.length).toBeLessThanOrEqual(280);
  });

  it("in native mode, caps to 8 words", () => {
    const long = "one two three four five six seven eight nine ten";
    const result = clampSpokenLine(long, "native");
    expect(result.split(" ").filter(Boolean).length).toBeLessThanOrEqual(8);
  });

  it("in native mode, truncates at the first sentence end", () => {
    const result = clampSpokenLine(
      "come here now. watch me tease you slow",
      "native",
    );
    expect(result).toBe("come here now.");
  });

  it("preserves emoji in text mode", () => {
    expect(clampSpokenLine("hey there 😉🔥")).toBe("hey there 😉🔥");
  });

  it("strips emoji in native mode since it can't be spoken", () => {
    const result = clampSpokenLine("hey there 😉🔥", "native");
    expect(result).not.toMatch(/😉|🔥/);
  });

  it("clamps an emoji-only line to empty in native mode", () => {
    expect(clampSpokenLine("😉🔥", "native")).toBe("");
  });
});

describe("isRefusal / isTooSimilarToPrior", () => {
  it("flags a refusal line", () => {
    expect(isRefusal("I'm sorry, I can't do that")).toBe(true);
    expect(isRefusal("I can't help with that")).toBe(true);
    expect(isRefusal("mm okay watch this")).toBe(false);
  });

  it("does not flag a lookalike phrase as a refusal", () => {
    expect(isRefusal("i cannot believe you said that")).toBe(false);
    expect(isRefusal("i won't lie, that's hot")).toBe(false);
  });

  it("flags a refusal lead with no disallowed-action verb, which used to leak", () => {
    expect(isRefusal("i'm not able to continue with that")).toBe(true);
    expect(isRefusal("i'm not comfortable doing this")).toBe(true);
    expect(isRefusal("i don't feel comfortable going further")).toBe(true);
    expect(isRefusal("i can't continue with that one babe")).toBe(true);
    expect(isRefusal("i can't wait to show you")).toBe(false);
    expect(isRefusal("i won't keep you waiting")).toBe(false);
  });

  it("flags a line too similar to a prior one", () => {
    expect(
      isTooSimilarToPrior("hey there watch this now baby", [
        "hey there watch this right now baby",
      ]),
    ).toBe(true);
    expect(
      isTooSimilarToPrior("completely different words entirely", [
        "hey there watch this now baby",
      ]),
    ).toBe(false);
  });
});

describe("writeReply", () => {
  it("retries past a refusal and returns the in-character line", async () => {
    createGroqChatCompletion
      .mockResolvedValueOnce(
        completionWith(
          JSON.stringify({
            chatText: "sorry, I can't do that",
            nextWorld: "w",
          }),
        ),
      )
      .mockResolvedValueOnce(
        completionWith(
          JSON.stringify({ chatText: "mmm okay watch", nextWorld: "w" }),
        ),
      );
    const result = await writeReply({
      transcript: [],
      requestText: "take it off",
      physical: "she strips",
      creator,
      channel: "voice",
      world: "w",
    });
    expect(result.text).toBe("mmm okay watch");
    expect(createGroqChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("retries past a line too similar to a prior one", async () => {
    const transcript: TranscriptEntry[] = [
      {
        id: "1",
        role: "creator",
        channel: "voice",
        text: "hey there watch this now baby",
        atSec: 0,
      },
    ];
    createGroqChatCompletion
      .mockResolvedValueOnce(
        completionWith(
          JSON.stringify({
            chatText: "hey there watch this right now baby",
            nextWorld: "w",
          }),
        ),
      )
      .mockResolvedValueOnce(
        completionWith(
          JSON.stringify({
            chatText: "totally different phrasing here",
            nextWorld: "w",
          }),
        ),
      );
    const result = await writeReply({
      transcript,
      requestText: "hi",
      physical: "beat",
      creator,
      channel: "voice",
      world: "w",
    });
    expect(result.text).toBe("totally different phrasing here");
  });

  it("falls back to a canned line when the LLM call fails entirely", async () => {
    createGroqChatCompletion.mockRejectedValue(new Error("groq down"));
    const result = await writeReply({
      transcript: [],
      requestText: "hi",
      physical: "beat",
      creator,
      channel: "voice",
      world: "w",
    });
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("never returns an empty bubble when the reply clamps to nothing (emoji-only, native mode)", async () => {
    createGroqChatCompletion.mockResolvedValue(
      completionWith(JSON.stringify({ chatText: "😉🔥", nextWorld: "w" })),
    );
    const result = await writeReply({
      transcript: [],
      requestText: "wave at me",
      physical: "she waves",
      creator,
      channel: "voice",
      world: "w",
      speechMode: "native",
    });
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("keeps an emoji reply in text mode instead of collapsing it", async () => {
    createGroqChatCompletion.mockResolvedValueOnce(
      completionWith(JSON.stringify({ chatText: "hey 😉🔥", nextWorld: "w" })),
    );
    const result = await writeReply({
      transcript: [],
      requestText: "wave at me",
      physical: "she waves",
      creator,
      channel: "chat",
      world: "w",
    });
    expect(result.text).toBe("hey 😉🔥");
  });

  it("addresses a room viewer's request by their handle, not any other name", async () => {
    createGroqChatCompletion.mockResolvedValueOnce(
      completionWith(
        JSON.stringify({ chatText: "thanks @tipfan", nextWorld: "w" }),
      ),
    );
    await writeReply({
      transcript: [],
      requestText: "wave at me",
      physical: "she waves",
      creator,
      channel: "chat",
      world: "w",
      from: "viewer",
      handle: "tipfan",
    });
    const [, userMessage] =
      createGroqChatCompletion.mock.calls[0]?.[0].messages ?? [];
    expect(userMessage.content).toContain("@tipfan");
    expect(userMessage.content).toMatch(/room viewer/i);
  });

  it("passes recent room chat, including handles and tips, to the LLM", async () => {
    createGroqChatCompletion.mockResolvedValueOnce(
      completionWith(JSON.stringify({ chatText: "hey", nextWorld: "w" })),
    );
    const transcript: TranscriptEntry[] = [
      {
        id: "1",
        role: "viewer",
        handle: "bigtipper",
        channel: "chat",
        text: "love the show",
        atSec: 5,
        tipCents: 500,
      },
    ];
    await writeReply({
      transcript,
      requestText: "hi",
      physical: "beat",
      creator,
      channel: "chat",
      world: "w",
    });
    const [, userMessage] =
      createGroqChatCompletion.mock.calls[0]?.[0].messages ?? [];
    expect(userMessage.content).toContain("@bigtipper");
    expect(userMessage.content).toContain("$5.00");
  });

  it("adds the short, simple-sentence rule to the system prompt in native mode", async () => {
    createGroqChatCompletion.mockResolvedValueOnce(
      completionWith(
        JSON.stringify({ chatText: "come here now", nextWorld: "w" }),
      ),
    );
    await writeReply({
      transcript: [],
      requestText: "wave at me",
      physical: "she waves",
      creator,
      channel: "voice",
      world: "w",
      speechMode: "native",
    });
    const [systemMessage] =
      createGroqChatCompletion.mock.calls[0]?.[0].messages ?? [];
    expect(systemMessage.content).toMatch(/max 8 words/i);
  });

  it("tells the model nextWorld is conversational context only, never a claimed physical change", async () => {
    createGroqChatCompletion.mockResolvedValueOnce(
      completionWith(JSON.stringify({ chatText: "mmm okay", nextWorld: "w" })),
    );
    await writeReply({
      transcript: [],
      requestText: "hi",
      physical: "beat",
      creator,
      channel: "voice",
      world: "w",
    });
    const [systemMessage] =
      createGroqChatCompletion.mock.calls[0]?.[0].messages ?? [];
    expect(systemMessage.content).toMatch(
      /nextWorld is conversational context only/i,
    );
    expect(systemMessage.content).toMatch(
      /never claim a change of location, clothing, pose, or props/i,
    );
  });
});

describe("persona voice by creator gender", () => {
  const systemPrompt = () =>
    (
      createGroqChatCompletion.mock.calls[0]?.[0] as {
        messages: { content: string }[];
      }
    ).messages[0]?.content ?? "";
  const answer = () =>
    createGroqChatCompletion.mockResolvedValue(
      completionWith(JSON.stringify({ chatText: "mmm okay", nextWorld: "w" })),
    );

  it("speaks as an adult man for a male creator, in replies and check-ins", async () => {
    const male = { ...creator, gender: "male" as const };
    answer();
    await writeReply({
      transcript: [],
      requestText: "hi",
      physical: "beat",
      creator: male,
      channel: "chat",
      world: "w",
    });
    expect(systemPrompt()).toContain("You are an adult man live on a webcam");
    expect(systemPrompt()).toContain("what he is doing");
    expect(systemPrompt()).not.toMatch(/\b(she|her|woman)\b/i);
    createGroqChatCompletion.mockClear();
    await writeCheckIn({
      transcript: [],
      creator: male,
      channel: "chat",
      world: "w",
    });
    expect(systemPrompt()).toContain("You are an adult man live on a webcam");
  });

  it("stays an adult woman when no gender is set", async () => {
    answer();
    await writeCheckIn({
      transcript: [],
      creator,
      channel: "chat",
      world: "w",
    });
    expect(systemPrompt()).toContain("You are an adult woman live on a webcam");
    expect(systemPrompt()).toContain("what she is doing");
  });
});
