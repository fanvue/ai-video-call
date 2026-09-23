import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/live/server/writeReply", () => ({
  writeReply: vi.fn(),
  writeCheckIn: vi.fn(),
}));
// The action rewrite is down in every test here, so the deterministic template is what gets asserted.
vi.mock("@/lib/groq", () => ({
  GROQ_TEXT_MODEL: "test-model",
  createGroqChatCompletion: () => Promise.reject(new Error("groq down")),
}));

const { getCurrentUser } = await import("@/lib/fanvue");
const { writeCheckIn, writeReply } =
  await import("@/lib/live/server/writeReply");
const { POST } = await import("./route");

const body = (requestText?: string) => ({
  creator: defaultCreatorProfile("Mia", "bedroom", "Auburn hair."),
  state: defaultLiveState("bedroom", {
    top: { on: true, description: "white crop top" },
    bottom: { on: true, description: "grey shorts" },
    bra: { on: true, description: "pink bra" },
    panties: { on: true, description: "pink panties" },
    removedOrder: [],
  }),
  transcript: [],
  channel: "chat",
  ...(requestText ? { requestText } : {}),
});

const post = (payload: unknown) =>
  POST(
    new Request("http://localhost/api/live/longlivePrompt", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset();
  vi.mocked(writeReply).mockReset();
  vi.mocked(writeCheckIn).mockReset();
});

describe("POST /api/live/longlivePrompt", () => {
  it("rejects unauthenticated requests", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    expect((await post(body("wave"))).status).toBe(401);
    expect(writeReply).not.toHaveBeenCalled();
  });

  it("returns the opening scene without writing a reply", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    const response = await post(body());
    const data = (await response.json()) as {
      prompt: string;
      settlePrompt: string;
      reply: string | null;
    };
    expect(response.status).toBe(200);
    expect(data.prompt).toContain("An adult woman");
    expect(data.settlePrompt).toContain("An adult woman");
    expect(data.reply).toBeNull();
    expect(writeReply).not.toHaveBeenCalled();
  });

  it("composes the request scene, the next state and her chat reply", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(writeReply).mockResolvedValue({
      text: "coming right up",
      nextWorld: "w",
    });
    const response = await post(body("take your top off"));
    const data = (await response.json()) as {
      prompt: string;
      reply: string;
      state: { wardrobe: { top: { on: boolean } } };
      wardrobeCheck: string[];
    };
    expect(data.reply).toBe("coming right up");
    expect(data.prompt).toContain("pulls her white crop top up over her head");
    expect(data.state.wardrobe.top.on).toBe(false);
    expect(data.wardrobeCheck).toEqual(["top"]);
  });

  it("names her clothing once it has been observed, and only when the ask leaves it unchanged", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(writeReply).mockResolvedValue({ text: "hi", nextWorld: "w" });
    const seen = await post({ ...body("wave"), wardrobeObserved: true });
    expect(((await seen.json()) as { prompt: string }).prompt).toContain(
      "wearing her white crop top",
    );
    const unseen = await post(body("wave"));
    expect(((await unseen.json()) as { prompt: string }).prompt).not.toContain(
      "wearing",
    );
    const changing = await post({
      ...body("take your top off"),
      wardrobeObserved: true,
    });
    expect(
      ((await changing.json()) as { prompt: string }).prompt,
    ).not.toContain("wearing");
  });

  it("falls back to the regex catalogue when the LLM request parser is down", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(writeReply).mockResolvedValue({ text: "ok", nextWorld: "w" });
    const response = await post({
      ...body("spin around"),
      intentParser: "llm",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { prompt: string }).prompt).toContain(
      "turns slowly all the way around",
    );
  });

  it("composes a check-in with her line and no state change", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(writeCheckIn).mockResolvedValue({
      text: "still there?",
      nextWorld: "w",
    });
    const response = await post({ ...body(), checkIn: true });
    const data = (await response.json()) as {
      prompt: string;
      reply: string;
      wardrobeCheck: string[];
    };
    expect(data.prompt).toContain("looks back into the camera");
    expect(data.reply).toBe("still there?");
    expect(data.wardrobeCheck).toEqual([]);
    expect(writeReply).not.toHaveBeenCalled();
  });

  it("fails closed with 502 when the reply model fails", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(writeReply).mockRejectedValue(new Error("groq down"));
    expect((await post(body("wave"))).status).toBe(502);
  });

  it("rejects a malformed body with 400", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    expect((await post({ creator: {} })).status).toBe(400);
  });
});
