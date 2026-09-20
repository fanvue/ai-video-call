import { describe, expect, it } from "vitest";
import { LiveDirector } from "./director";
import type {
  ClipResult,
  CreatorProfile,
  LiveState,
  PlannedBeat,
} from "@/lib/live/contract";

const creator: CreatorProfile = {
  id: "c1",
  displayName: "Her",
  lookLock: "brown hair",
  sceneId: "bedroom",
  tipMenu: [],
};

const garmentOn = (description: string) => ({ on: true, description });
const garmentOff = (description: string) => ({ on: false, description });

const baseBody = {
  pose: "sitting" as const,
  facing: "camera" as const,
  hands: "free" as const,
  contact: "none" as const,
  prop: "none" as const,
  framing: "medium" as const,
};

const dressedState: LiveState = {
  wardrobe: {
    top: garmentOn("tank top"),
    bottom: garmentOn("shorts"),
    bra: garmentOn("bra"),
    panties: garmentOn("panties"),
    removedOrder: [],
  },
  body: baseBody,
  baselineBody: baseBody,
  world: "settling in",
  surroundings: "a bedroom",
};

const makeDirector = (state: LiveState = dressedState, now = 0) =>
  new LiveDirector({
    creator,
    anchorFrameUrl: "https://example.com/anchor.jpg",
    seedFrameUrl: "https://example.com/anchor.jpg",
    liveState: state,
    now,
  });

const clipResult = (overrides: Partial<ClipResult>): ClipResult => ({
  clipId: "clip-1",
  jobKind: "idle",
  videoUrl: "https://example.com/clip.mp4",
  durationSec: 10,
  seedFrameUrl: "https://example.com/frame.jpg",
  state: dressedState,
  reply: null,
  followUps: [],
  guard: { checked: true, issues: [], repaired: false },
  timings: { planMs: 0, renderMs: 0, frameMs: 0, guardMs: 0, repairMs: 0 },
  costUsd: 0.01,
  ...overrides,
});

describe("LiveDirector", () => {
  it("starts with a single greeting job queued", () => {
    const director = makeDirector();
    expect(director.getState().jobQueue).toEqual([{ kind: "greeting" }]);
    expect(director.nextJob()).toEqual({ kind: "greeting" });
    expect(director.nextJob()).toEqual({ kind: "idle" });
  });

  it("queues a reply job ahead of idle-priority work and records the fan transcript entry", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting
    const { entry, job } = director.fanRequest(
      { text: "hey", channel: "chat" },
      1000,
    );
    expect(entry.role).toBe("fan");
    expect(job).toEqual({
      kind: "reply",
      requestId: entry.id,
      text: "hey",
      channel: "chat",
    });
    expect(director.getState().jobQueue[0]).toEqual(job);
  });

  it("inserts a new reply behind running beats but ahead of an already-queued settle", () => {
    const director = makeDirector();
    director.nextJob();
    const beat: PlannedBeat = {
      id: "b1",
      physical: "she waves",
      durationSec: 10,
      nextState: { wardrobe: dressedState.wardrobe, body: baseBody },
    };
    director.clipCompleted(
      clipResult({
        jobKind: "reply",
        followUps: [beat],
        state: dressedState,
      }),
      1000,
    );
    expect(director.getState().jobQueue).toEqual([{ kind: "beat", beat }]);

    const { job } = director.fanRequest(
      { text: "again", channel: "chat" },
      2000,
    );
    expect(director.getState().jobQueue).toEqual([{ kind: "beat", beat }, job]);
  });

  it("pushes settle once the beat chain ends away from baseline body", () => {
    const director = makeDirector();
    director.nextJob();
    const movedState: LiveState = {
      ...dressedState,
      body: { ...baseBody, pose: "kneeling" },
    };
    director.clipCompleted(
      clipResult({ jobKind: "reply", followUps: [], state: movedState }),
      1000,
    );
    expect(director.getState().jobQueue).toEqual([{ kind: "settle" }]);
  });

  it("does not push settle when the body already matches baseline", () => {
    const director = makeDirector();
    director.nextJob();
    director.clipCompleted(
      clipResult({ jobKind: "reply", followUps: [], state: dressedState }),
      1000,
    );
    expect(director.getState().jobQueue).toEqual([]);
  });

  it("schedules redress in reverse removal order after the idle threshold, only once", () => {
    const undressedState: LiveState = {
      ...dressedState,
      wardrobe: {
        ...dressedState.wardrobe,
        top: garmentOff("tank top"),
        bra: garmentOff("bra"),
        removedOrder: ["top", "bra"],
      },
    };
    const director = makeDirector(undressedState, 0);
    director.nextJob();
    director.tick(120_000);
    expect(director.getState().jobQueue).toEqual([
      { kind: "redress", garment: "bra" },
      { kind: "redress", garment: "top" },
    ]);

    director.nextJob();
    director.nextJob();
    director.tick(130_000);
    expect(director.getState().jobQueue).toEqual([]);
  });

  it("does not schedule redress when nothing is off", () => {
    const director = makeDirector(dressedState, 0);
    director.nextJob();
    director.tick(120_000);
    expect(director.getState().jobQueue).toEqual([]);
  });

  it("schedules a checkIn after the shorter idle threshold", () => {
    const director = makeDirector(dressedState, 0);
    director.nextJob();
    director.tick(90_000);
    expect(director.getState().jobQueue).toEqual([
      { kind: "checkIn", channel: "chat" },
    ]);
  });

  it("resets idle timers on a new fan request", () => {
    const director = makeDirector(dressedState, 0);
    director.nextJob();
    director.tick(90_000);
    director.nextJob();
    director.fanRequest({ text: "hi", channel: "chat" }, 91_000);
    director.nextJob();
    director.tick(91_500);
    expect(director.getState().jobQueue).toEqual([]);
  });
});
