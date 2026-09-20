import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorProfile, TranscriptEntry } from "../contract";
import {
  clampSpokenLine,
  isRefusal,
  isTooSimilarToPrior,
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
});

describe("isRefusal / isTooSimilarToPrior", () => {
  it("flags a refusal line", () => {
    expect(isRefusal("I'm sorry, I can't do that")).toBe(true);
    expect(isRefusal("mm okay watch this")).toBe(false);
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
});
