import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Body,
  ClipRequest,
  CreatorProfile,
  LiveSessionSnapshot,
  LiveState,
  Wardrobe,
} from "../contract";

const render = vi.fn();
const renderBackendFor = vi.fn();
vi.mock("./renderClip", () => ({
  renderBackendFor: (...args: unknown[]) => renderBackendFor(...args),
}));

const extractLastFrameUrl = vi.fn();
const extractMidFrameUrl = vi.fn();
vi.mock("@/lib/fal/extractLastFrame", () => ({
  extractLastFrameUrl: (...args: unknown[]) => extractLastFrameUrl(...args),
  extractMidFrameUrl: (...args: unknown[]) => extractMidFrameUrl(...args),
}));

const correctFrameIdentityDrift = vi.fn();
vi.mock("@/lib/fal/requestFrameIdentityCorrection", () => ({
  correctFrameIdentityDrift: (...args: unknown[]) =>
    correctFrameIdentityDrift(...args),
}));

const guardFrame = vi.fn();
const repairFrame = vi.fn();
vi.mock("./frameGuard", () => ({
  guardFrame: (...args: unknown[]) => guardFrame(...args),
  repairFrame: (...args: unknown[]) => repairFrame(...args),
}));

const writeReply = vi.fn();
const writeCheckIn = vi.fn();
vi.mock("./writeReply", () => ({
  writeReply: (...args: unknown[]) => writeReply(...args),
  writeCheckIn: (...args: unknown[]) => writeCheckIn(...args),
}));

const { generateClip } = await import("./generateClip");

const wardrobe = (overrides: Partial<Wardrobe> = {}): Wardrobe => ({
  top: { on: true, description: "black ribbed tank top" },
  bottom: { on: true, description: "denim shorts" },
  bra: { on: true, description: "black lace bra" },
  panties: { on: true, description: "black lace panties" },
  removedOrder: [],
  ...overrides,
});

const body = (overrides: Partial<Body> = {}): Body => ({
  pose: "sitting",
  facing: "camera",
  hands: "free",
  contact: "none",
  prop: "none",
  framing: "wider",
  ...overrides,
});

const creator: CreatorProfile = {
  id: "creator-1",
  displayName: "Aria",
  lookLock: "long dark hair, olive skin, athletic build",
  sceneId: "bedroom",
  tipMenu: [],
};

const state = (overrides: Partial<LiveState> = {}): LiveState => ({
  wardrobe: wardrobe(),
  body: body(),
  baselineBody: body(),
  world: "quiet evening, laptop propped on the desk",
  surroundings: "bedroom desk with a laptop webcam",
  ...overrides,
});

const session = (
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot => ({
  creator,
  state: state(),
  seedFrameUrl: "https://example.com/seed.jpg",
  anchorFrameUrl: "https://example.com/anchor.jpg",
  elapsedSec: 10,
  transcript: [],
  ...overrides,
});

const clipRequest = (overrides: Partial<ClipRequest> = {}): ClipRequest => ({
  session: session(),
  job: { kind: "idle" },
  backend: "turbo",
  speechMode: "text",
  ...overrides,
});

const MID_URL = "https://example.com/mid.jpg";
const LAST_URL = "https://example.com/extracted.jpg";

// guardFrame is called once per checked frame; distinguish by which frame it was handed.
const guardByFrame = (
  byFrame: Record<string, { issues: string[]; observed: unknown }>,
) =>
  vi.fn(async ({ frameUrl }: { frameUrl: string }) => ({
    checked: true,
    ...byFrame[frameUrl],
  }));

beforeEach(() => {
  render.mockReset();
  renderBackendFor.mockReset();
  extractLastFrameUrl.mockReset();
  extractMidFrameUrl.mockReset();
  correctFrameIdentityDrift.mockReset();
  guardFrame.mockReset();
  repairFrame.mockReset();
  writeReply.mockReset();
  writeCheckIn.mockReset();

  render.mockResolvedValue({
    videoUrl: "https://example.com/out.mp4",
    costUsd: 0.25,
  });
  guardFrame.mockResolvedValue({ checked: false, issues: [], observed: null });
  extractLastFrameUrl.mockResolvedValue(LAST_URL);
  extractMidFrameUrl.mockResolvedValue(MID_URL);
});

describe("generateClip: idle", () => {
  it("guards only the midpoint frame — start/end are the anchor by construction — and always plays from the session seed", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: [],
      observed: { wardrobe: {} },
    });
    const req = clipRequest({ job: { kind: "idle" } });

    const result = await generateClip(req);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        seedFrameUrl: req.session.seedFrameUrl,
        endFrameUrl: req.session.seedFrameUrl,
      }),
    );
    expect(extractMidFrameUrl).toHaveBeenCalledTimes(1);
    expect(extractLastFrameUrl).not.toHaveBeenCalled();
    expect(guardFrame).toHaveBeenCalledTimes(1);
    expect(repairFrame).not.toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.loops).toBe(true);
    expect(result.seedFrameUrl).toBe(req.session.seedFrameUrl);
    expect(result.verdict).toBe("approved");
  });

  it("on the reference backend (no end frame), still only reuses the session seed — its own frame is never a seed", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: false, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: [],
      observed: { wardrobe: {} },
    });
    const req = clipRequest({ job: { kind: "idle" }, backend: "reference" });

    const result = await generateClip(req);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ endFrameUrl: undefined }),
    );
    expect(result.loops).toBe(false);
    expect(result.seedFrameUrl).toBe(req.session.seedFrameUrl);
  });

  it("is rejected when the midpoint shows a canon-on garment absent, naming that garment", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: [],
      observed: { wardrobe: { bra: false } },
    });
    const req = clipRequest({ job: { kind: "idle" } });

    const result = await generateClip(req);

    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toMatch(/bra/);
    expect(result.seedFrameUrl).toBe(req.session.seedFrameUrl);
  });

  it("approves when the midpoint reports a garment as unknown rather than absent", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: [],
      observed: { wardrobe: {} },
    });
    const req = clipRequest({ job: { kind: "idle" } });

    const result = await generateClip(req);

    expect(result.verdict).toBe("approved");
    expect(result.rejectReason).toBeNull();
  });

  it("is rejected with a reason naming extractFrame when the midpoint extraction fails or times out", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    extractMidFrameUrl.mockRejectedValueOnce(new Error("timed out"));
    const req = clipRequest({ job: { kind: "idle" } });

    const result = await generateClip(req);

    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toMatch(/extractFrame/);
    expect(guardFrame).not.toHaveBeenCalled();
  });
});

describe("generateClip: hold clips other than idle", () => {
  it("greeting checks both the midpoint and last frame, and is rejected when the last frame shows extra limbs", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockImplementation(
      guardByFrame({
        [MID_URL]: { issues: [], observed: { wardrobe: {} } },
        [LAST_URL]: {
          issues: ["extra or malformed limbs visible"],
          observed: { wardrobe: {} },
        },
      }),
    );
    const req = clipRequest({ job: { kind: "greeting" } });

    const result = await generateClip(req);

    expect(extractMidFrameUrl).toHaveBeenCalled();
    expect(extractLastFrameUrl).toHaveBeenCalled();
    expect(guardFrame).toHaveBeenCalledTimes(2);
    expect(result.loops).toBe(false);
    expect(result.verdict).toBe("rejected");
    expect(repairFrame).not.toHaveBeenCalled();
  });

  it("greeting approves and uses the last frame as its next seed when both checks pass clean", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: [],
      observed: { wardrobe: {} },
    });
    const req = clipRequest({ job: { kind: "greeting" } });

    const result = await generateClip(req);

    expect(result.verdict).toBe("approved");
    expect(result.seedFrameUrl).toBe(LAST_URL);
  });

  it("a spin act (hold) is rejected when its last frame shows panties absent while canon has them on", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockImplementation(
      guardByFrame({
        [MID_URL]: { issues: [], observed: { wardrobe: {} } },
        [LAST_URL]: { issues: [], observed: { wardrobe: { panties: false } } },
      }),
    );
    const req = clipRequest({
      job: {
        kind: "beat",
        beat: { id: "b1", intent: { type: "act", act: "spin" }, attempt: 0 },
      },
    });

    const result = await generateClip(req);

    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toMatch(/panties/);
  });

  it("a pose beat (hold, mid-chain) guards both frames and skips repair on an anatomy issue, rejecting instead", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: ["extra or malformed limbs visible"],
      observed: { wardrobe: {} },
    });
    const req = clipRequest({
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          intent: { type: "pose", pose: "standing", facing: "camera" },
          attempt: 0,
        },
      },
    });

    const result = await generateClip(req);

    expect(extractMidFrameUrl).toHaveBeenCalled();
    expect(extractLastFrameUrl).toHaveBeenCalled();
    expect(repairFrame).not.toHaveBeenCalled();
    expect(result.verdict).toBe("rejected");
  });

  it("an approved hold clip reconciles pose but never wardrobe", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: [],
      observed: { wardrobe: { bra: false }, pose: "standing" },
    });
    const req = clipRequest({
      job: { kind: "checkIn", channel: "chat" },
    });

    const result = await generateClip(req);

    // bra:false disagrees with canon (on), so this is rejected — wardrobe and pose both stay canon.
    expect(result.verdict).toBe("rejected");
    expect(result.state.wardrobe.bra.on).toBe(true);
    expect(result.state.body.pose).toBe("sitting");
  });

  it("checkIn is rejected with a reason naming the failed step when a frame check never ran", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    // Default guardFrame mock resolves checked:false, simulating a vision failure/refusal.
    const req = clipRequest({
      job: { kind: "checkIn", channel: "chat" },
      session: session({ elapsedSec: 400 }),
    });

    const result = await generateClip(req);

    expect(guardFrame).toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toMatch(/guardFrame/);
    expect(result.seedFrameUrl).toBe(LAST_URL);
  });
});

describe("generateClip: non-hold clips (requested wardrobe change or explicit act)", () => {
  it("a reply job extracts only the last frame and guards it, and does not loop", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    writeReply.mockResolvedValue({ text: "mmm okay", nextWorld: "w" });
    const req = clipRequest({
      job: {
        kind: "reply",
        requestId: "r1",
        text: "take off your top",
        channel: "voice",
        from: "fan",
      },
    });

    const result = await generateClip(req);

    expect(extractMidFrameUrl).not.toHaveBeenCalled();
    expect(extractLastFrameUrl).toHaveBeenCalledWith(
      "https://example.com/out.mp4",
      expect.any(Number),
    );
    expect(guardFrame).toHaveBeenCalledTimes(1);
    expect(repairFrame).not.toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.loops).toBe(false);
    expect(result.verdict).toBe("approved");
  });

  it("a beat whose guard observes bra on while expected off commits the observed state", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: ["bra should be off but frame shows it on"],
      observed: { wardrobe: { bra: true } },
    });
    const req = clipRequest({
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          intent: { type: "removeGarment", garment: "bra" },
          attempt: 0,
        },
      },
    });

    const result = await generateClip(req);

    expect(repairFrame).not.toHaveBeenCalled();
    expect(result.observed).toEqual({ wardrobe: { bra: true } });
    expect(result.state.wardrobe.bra.on).toBe(true);
    expect(result.verdict).toBe("approved");
  });

  it("a removeGarment beat whose vision call fails is still approved — never rejected by wardrobe observation, and the missing check fails open here (asymmetric with hold clips)", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    // Default guardFrame mock resolves checked:false, simulating a refused/failed vision call.
    const req = clipRequest({
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          intent: { type: "removeGarment", garment: "bra" },
          attempt: 0,
        },
      },
    });

    const result = await generateClip(req);

    expect(result.verdict).toBe("approved");
    expect(result.rejectReason).toBeNull();
  });

  it("is rejected only for extraPeople/extraLimbs, and only when the check ran", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: ["extra person visible in frame"],
      observed: null,
    });
    const req = clipRequest({
      job: {
        kind: "beat",
        beat: { id: "b1", intent: { type: "touch" }, attempt: 0 },
      },
    });

    const result = await generateClip(req);

    expect(result.verdict).toBe("rejected");
    expect(result.rejectReason).toMatch(/extra person/);
  });

  it("never runs blind periodic identity correction, even at a long elapsed time", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    const req = clipRequest({
      job: {
        kind: "beat",
        beat: {
          id: "b1",
          intent: { type: "removeGarment", garment: "top" },
          attempt: 0,
        },
      },
      session: session({ elapsedSec: 400 }),
    });

    const result = await generateClip(req);

    expect(guardFrame).toHaveBeenCalled();
    expect(correctFrameIdentityDrift).not.toHaveBeenCalled();
    expect(result.seedFrameUrl).toBe(LAST_URL);
  });
});

describe("generateClip: world state (item 3)", () => {
  it("adopts nextWorld from the reply only when the clip is approved", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: false,
      issues: [],
      observed: null,
    });
    writeReply.mockResolvedValue({
      text: "mmm okay",
      nextWorld: "a brand new world",
    });
    const req = clipRequest({
      job: {
        kind: "reply",
        requestId: "r1",
        text: "take off your top",
        channel: "voice",
        from: "fan",
      },
    });

    const result = await generateClip(req);

    expect(result.verdict).toBe("approved");
    expect(result.state.world).toBe("a brand new world");
  });

  it("keeps the previous world unchanged when the clip is rejected", async () => {
    renderBackendFor.mockReturnValue({ supportsEndFrame: true, render });
    guardFrame.mockResolvedValue({
      checked: true,
      issues: ["extra person visible in frame"],
      observed: null,
    });
    writeReply.mockResolvedValue({
      text: "mmm okay",
      nextWorld: "a brand new world",
    });
    const req = clipRequest({
      job: {
        kind: "reply",
        requestId: "r1",
        text: "take off your top",
        channel: "voice",
        from: "fan",
      },
    });

    const result = await generateClip(req);

    expect(result.verdict).toBe("rejected");
    expect(result.state.world).toBe(req.session.state.world);
  });
});
