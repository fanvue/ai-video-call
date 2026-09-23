import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/live/server/writeReply", () => ({ writeReply: vi.fn() }));

const { getCurrentUser } = await import("@/lib/fanvue");
const { writeReply } = await import("@/lib/live/server/writeReply");
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
    expect(data.prompt).toContain("One adult woman");
    expect(data.settlePrompt).toContain("One adult woman");
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
    };
    expect(data.reply).toBe("coming right up");
    expect(data.prompt).toContain("she takes off her white crop top");
    expect(data.state.wardrobe.top.on).toBe(false);
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
