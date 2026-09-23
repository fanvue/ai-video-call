import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorProfile, LiveState } from "../contract";

vi.mock("./frameGuard", () => ({ guardFrame: vi.fn() }));
vi.mock("@/lib/groq", () => ({
  GROQ_TEXT_MODEL: "test-model",
  createGroqChatCompletion: () => Promise.reject(new Error("groq down")),
}));

const { guardFrame } = await import("./frameGuard");
const { observeLongLiveWardrobe } = await import("./longliveObserve");

const body = {
  pose: "sitting",
  facing: "camera",
  hands: "free",
  contact: "none",
  prop: "none",
  framing: "medium",
} as const;

// The state a "take your bra off" left her in: bra assumed off.
const expected: LiveState = {
  wardrobe: {
    top: { on: false, description: "top" },
    bottom: { on: false, description: "bottoms" },
    bra: { on: false, description: "white lace bra" },
    panties: { on: true, description: "white lace panties" },
    removedOrder: ["bra"],
  },
  body,
  baselineBody: body,
  world: "w",
  surroundings: "A bedroom.",
};

const creator: CreatorProfile = {
  id: "creator-1",
  displayName: "Mia",
  lookLock: "Dark brown hair.",
  sceneId: "bedroom",
  tipMenu: [],
};

const observe = () =>
  observeLongLiveWardrobe({
    creator,
    expected,
    garments: ["bra"],
    frameUrl: "data:image/jpeg;base64,AAAA",
    referenceImageUrl: "https://v3.fal.media/files/ref.jpg",
  });

const seen = (wardrobe: Record<string, boolean>) =>
  vi.mocked(guardFrame).mockResolvedValue({
    checked: true,
    issues: [],
    observed: { wardrobe, pose: undefined },
  });

beforeEach(() => {
  vi.mocked(guardFrame).mockReset();
});

describe("observeLongLiveWardrobe", () => {
  it("confirms a change vision sees and names the clothing in the settle scene", async () => {
    seen({ bra: false, panties: true });
    const result = await observe();
    expect(result.confirmed).toBe(true);
    expect(result.state.wardrobe.bra.on).toBe(false);
    expect(result.settlePrompt).toContain(
      "topless, wearing only her white lace panties",
    );
    expect(vi.mocked(guardFrame).mock.calls[0]?.[0]).toMatchObject({
      frameUrl: "data:image/jpeg;base64,AAAA",
      anchorFrameUrl: "https://v3.fal.media/files/ref.jpg",
    });
  });

  it("reconciles the wardrobe back when vision sees the garment still on", async () => {
    seen({ bra: true });
    const result = await observe();
    expect(result.confirmed).toBe(false);
    expect(result.state.wardrobe.bra.on).toBe(true);
    expect(result.state.wardrobe.removedOrder).toEqual([]);
    expect(result.settlePrompt).toBeNull();
  });

  it("does not confirm a garment vision could not judge", async () => {
    seen({ panties: true });
    const result = await observe();
    expect(result.confirmed).toBe(false);
    expect(result.state).toEqual(expected);
  });

  it("does not confirm when the vision call fails", async () => {
    vi.mocked(guardFrame).mockResolvedValue({
      checked: false,
      issues: [],
      observed: null,
    });
    expect(await observe()).toEqual({
      confirmed: false,
      seen: false,
      state: expected,
      settlePrompt: null,
    });
  });

  it("does not confirm when vision is slower than the budget", async () => {
    vi.useFakeTimers();
    vi.mocked(guardFrame).mockReturnValue(new Promise(() => undefined));
    const pending = observe();
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await pending).confirmed).toBe(false);
    vi.useRealTimers();
  });
});
