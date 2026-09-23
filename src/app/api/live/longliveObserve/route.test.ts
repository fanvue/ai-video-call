import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCreatorProfile } from "@/lib/live/client/defaultCreatorProfile";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/live/server/longliveObserve", () => ({
  observeLongLiveWardrobe: vi.fn(),
}));

const { getCurrentUser } = await import("@/lib/fanvue");
const { observeLongLiveWardrobe } =
  await import("@/lib/live/server/longliveObserve");
const { POST } = await import("./route");

const state = defaultLiveState("bedroom", {
  top: { on: false, description: "top" },
  bottom: { on: false, description: "bottoms" },
  bra: { on: false, description: "white bra" },
  panties: { on: true, description: "white panties" },
  removedOrder: ["bra"],
});

const body = {
  creator: defaultCreatorProfile("Mia", "bedroom", "Auburn hair."),
  state,
  garments: ["bra"],
  frameBase64: "AAAA",
  referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
};

const post = (payload: unknown) =>
  POST(
    new Request("http://localhost/api/live/longliveObserve", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset();
  vi.mocked(observeLongLiveWardrobe).mockReset();
});

describe("POST /api/live/longliveObserve", () => {
  it("rejects unauthenticated requests before any vision call", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    expect((await post(body)).status).toBe(401);
    expect(observeLongLiveWardrobe).not.toHaveBeenCalled();
  });

  it("hands the frame to vision as a JPEG data URI and returns the observation", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(observeLongLiveWardrobe).mockResolvedValue({
      confirmed: true,
      state,
      settlePrompt: "settle",
    });
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      confirmed: true,
      state,
      settlePrompt: "settle",
    });
    expect(vi.mocked(observeLongLiveWardrobe).mock.calls[0]?.[0]).toMatchObject(
      {
        garments: ["bra"],
        frameUrl: "data:image/jpeg;base64,AAAA",
        referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
      },
    );
  });

  it.each([
    ["no garments", { ...body, garments: [] }],
    ["a non-https reference", { ...body, referenceImageUrl: "http://x/y.jpg" }],
    ["an oversized frame", { ...body, frameBase64: "A".repeat(1_500_001) }],
  ])("rejects %s with 400", async (_, payload) => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    expect((await post(payload)).status).toBe(400);
    expect(observeLongLiveWardrobe).not.toHaveBeenCalled();
  });
});
