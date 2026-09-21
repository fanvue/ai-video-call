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

// Fresh clipId per call by default; pass clipId explicitly to simulate a repeat delivery.
let clipResultCounter = 0;
const clipResult = (overrides: Partial<ClipResult>): ClipResult => ({
  clipId: `clip-${++clipResultCounter}`,
  jobKind: "idle",
  videoUrl: "https://example.com/clip.mp4",
  durationSec: 10,
  seedFrameUrl: "https://example.com/frame.jpg",
  loops: true,
  state: dressedState,
  reply: null,
  followUps: [],
  guard: { checked: true, issues: [], repaired: false },
  observed: null,
  verdict: "approved",
  rejectReason: null,
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
      from: "fan",
    });
    expect(director.getState().jobQueue[0]).toEqual(job);
  });

  it("puts a completed clip's follow-ups at the FRONT of the queue, ahead of a request that arrived mid-render", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting, dispatches it as lastDispatchedJob
    const beat: PlannedBeat = {
      id: "b1",
      intent: { type: "removeGarment", garment: "panties" },
      attempt: 0,
    };
    // A request arrives while the reply clip (with this follow-up) is still "rendering".
    const { job: midRenderRequest } = director.fanRequest(
      { text: "suck the dildo", channel: "chat" },
      500,
    );
    expect(director.getState().jobQueue).toEqual([midRenderRequest]);

    director.clipCompleted(
      clipResult({
        jobKind: "reply",
        followUps: [beat],
        state: dressedState,
      }),
      1000,
    );

    // The follow-up from the just-completed clip must run before the request that arrived mid-render.
    expect(director.getState().jobQueue).toEqual([
      { kind: "beat", beat },
      midRenderRequest,
    ]);
  });

  it("inserts a new reply behind running beats", () => {
    const director = makeDirector();
    director.nextJob();
    const beat: PlannedBeat = {
      id: "b1",
      intent: { type: "act", act: "gesture" },
      attempt: 0,
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

  it("drops a satisfied beat from nextJob without ever returning it", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting -> lastDispatchedJob is greeting
    const satisfiedBeat: PlannedBeat = {
      id: "b1",
      // panties are already on in dressedState, so addGarment is already satisfied.
      intent: { type: "addGarment", garment: "panties" },
      attempt: 0,
    };
    const realBeat: PlannedBeat = {
      id: "b2",
      intent: { type: "act", act: "gesture" },
      attempt: 0,
    };
    director.clipCompleted(
      clipResult({
        jobKind: "reply",
        followUps: [satisfiedBeat, realBeat],
        state: dressedState,
      }),
      1000,
    );
    expect(director.getState().jobQueue).toEqual([
      { kind: "beat", beat: satisfiedBeat },
      { kind: "beat", beat: realBeat },
    ]);

    // nextJob must silently skip the satisfied beat and hand out the real one.
    expect(director.nextJob()).toEqual({ kind: "beat", beat: realBeat });
    expect(director.getState().jobQueue).toEqual([]);
  });

  it("re-queues a removeGarment beat once (attempt 1) when the guarded result shows it unmet, then stops", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting -> lastDispatchedJob is greeting
    const beat: PlannedBeat = {
      id: "b1",
      intent: { type: "removeGarment", garment: "bra" },
      attempt: 0,
    };
    director.clipCompleted(
      clipResult({ jobKind: "reply", followUps: [beat], state: dressedState }),
      500,
    );
    expect(director.getState().jobQueue).toEqual([{ kind: "beat", beat }]);
    expect(director.nextJob()).toEqual({ kind: "beat", beat });

    // Bra is still on in the result state -> the target was not met -> one retry at attempt 1.
    director.clipCompleted(
      clipResult({ jobKind: "beat", followUps: [], state: dressedState }),
      1000,
    );
    const retried = { ...beat, attempt: 1 };
    expect(director.getState().jobQueue).toEqual([
      { kind: "beat", beat: retried },
    ]);
    expect(director.nextJob()).toEqual({ kind: "beat", beat: retried });

    // Second attempt also comes back unmet: no further retry (attempt is already 1).
    director.clipCompleted(
      clipResult({ jobKind: "beat", followUps: [], state: dressedState }),
      1500,
    );
    expect(director.getState().jobQueue).toEqual([]);
  });

  it("does not retry once the guarded result shows the removal actually happened", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting -> lastDispatchedJob is greeting
    const beat: PlannedBeat = {
      id: "b1",
      intent: { type: "removeGarment", garment: "bra" },
      attempt: 0,
    };
    director.clipCompleted(
      clipResult({ jobKind: "reply", followUps: [beat], state: dressedState }),
      500,
    );
    director.nextJob();

    const braOffState: LiveState = {
      ...dressedState,
      wardrobe: { ...dressedState.wardrobe, bra: garmentOff("bra") },
    };
    director.clipCompleted(
      clipResult({ jobKind: "beat", followUps: [], state: braOffState }),
      1000,
    );
    expect(director.getState().jobQueue).toEqual([]);
  });

  it("queues a rest beat after REST_AFTER_IDLE_MS when holding a prop, never redress", () => {
    const holdingPropState: LiveState = {
      ...dressedState,
      body: { ...baseBody, hands: "holdingProp", prop: "vibrator" },
    };
    const director = makeDirector(holdingPropState, 0);
    director.nextJob();
    director.tick(20_000, { busy: false });
    expect(director.getState().jobQueue).toEqual([
      {
        kind: "beat",
        beat: { id: "rest-1", intent: { type: "rest" }, attempt: 0 },
      },
    ]);
  });

  it("does not schedule rest again once already scheduled in this idle window", () => {
    const holdingPropState: LiveState = {
      ...dressedState,
      body: { ...baseBody, hands: "holdingProp", prop: "vibrator" },
    };
    const director = makeDirector(holdingPropState, 0);
    director.nextJob();
    director.tick(20_000, { busy: false });
    director.nextJob();
    director.tick(21_000, { busy: false });
    expect(director.getState().jobQueue).toEqual([]);
  });

  it("does not schedule rest when hands are already free", () => {
    const director = makeDirector(dressedState, 0);
    director.nextJob();
    director.tick(20_000, { busy: false });
    expect(director.getState().jobQueue).toEqual([]);
  });

  it("schedules a checkIn after the shorter idle threshold", () => {
    const director = makeDirector(dressedState, 0);
    director.nextJob();
    director.tick(90_000, { busy: false });
    expect(director.getState().jobQueue).toEqual([
      { kind: "checkIn", channel: "chat" },
    ]);
  });

  it("does not commit state, transcript or follow-ups from a guard-rejected clip", () => {
    const director = makeDirector();
    director.nextJob(); // greeting
    const before = director.getState();
    director.clipCompleted(
      clipResult({
        jobKind: "reply",
        verdict: "rejected",
        rejectReason: "extra person in frame",
        state: {
          ...dressedState,
          wardrobe: {
            ...dressedState.wardrobe,
            bra: { ...dressedState.wardrobe.bra, on: false },
          },
        },
        seedFrameUrl: "https://example.com/rejected.jpg",
        reply: { text: "hey", channel: "chat", typingLeadSec: 0 },
        followUps: [
          { id: "b1", intent: { type: "act", act: "spin" }, attempt: 0 },
        ],
      }),
      1000,
    );
    const after = director.getState();
    expect(after.liveState).toBe(before.liveState);
    expect(after.seedFrameUrl).toBe(before.seedFrameUrl);
    expect(after.transcript).toEqual(before.transcript);
    expect(after.jobQueue).toEqual(before.jobQueue);
  });

  it("queues a viewer reply job tagged with the viewer's handle", () => {
    const director = makeDirector();
    director.nextJob();
    const { entry, job } = director.viewerRequest(
      { handle: "nightowl_92", text: "wave at me" },
      1000,
    );
    expect(entry.role).toBe("viewer");
    expect(entry.handle).toBe("nightowl_92");
    expect(job).toEqual({
      kind: "reply",
      requestId: entry.id,
      text: "wave at me",
      channel: "chat",
      from: "viewer",
      handle: "nightowl_92",
    });
    expect(director.getState().jobQueue[0]).toEqual(job);
  });

  it("marks a tipped viewer request as paid on both the transcript entry and the job", () => {
    const director = makeDirector();
    director.nextJob();
    const { entry, job } = director.viewerRequest(
      { handle: "kdub", text: "dance for me", tipCents: 500 },
      1000,
    );
    expect(entry.paid).toBe(true);
    expect(entry.tipCents).toBe(500);
    expect(job).toMatchObject({ from: "viewer", paid: true });
  });

  it("lets a fan request pre-empt a viewer request still queued (not yet rendering)", () => {
    const director = makeDirector();
    director.nextJob();
    const { job: viewerJob } = director.viewerRequest(
      { handle: "kdub", text: "wave at me" },
      1000,
    );
    expect(director.getState().jobQueue).toEqual([viewerJob]);

    const { job: fanJob } = director.fanRequest(
      { text: "hey", channel: "chat" },
      2000,
    );
    expect(director.getState().jobQueue).toEqual([fanJob, viewerJob]);
  });

  it("does not let a viewer request jump ahead of an already-queued fan request", () => {
    const director = makeDirector();
    director.nextJob();
    const { job: fanJob } = director.fanRequest(
      { text: "hey", channel: "chat" },
      1000,
    );
    const { job: viewerJob } = director.viewerRequest(
      { handle: "kdub", text: "wave at me" },
      2000,
    );
    expect(director.getState().jobQueue).toEqual([fanJob, viewerJob]);
  });

  it("resets idle timers on a new fan request", () => {
    const director = makeDirector(dressedState, 0);
    director.nextJob();
    director.tick(90_000, { busy: false });
    director.nextJob();
    director.fanRequest({ text: "hi", channel: "chat" }, 91_000);
    director.nextJob();
    director.tick(91_500, { busy: false });
    expect(director.getState().jobQueue).toEqual([]);
  });

  it("runs three fan requests that arrive during one render in FIFO order", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting; request A is now "rendering" (not in the queue)
    const { job: jobB } = director.fanRequest(
      { text: "B", channel: "chat" },
      1000,
    );
    expect(director.getState().jobQueue).toEqual([jobB]);
    const { job: jobC } = director.fanRequest(
      { text: "C", channel: "chat" },
      2000,
    );
    // C must land behind B, not pre-empt it: A -> B -> C.
    expect(director.getState().jobQueue).toEqual([jobB, jobC]);
  });

  it("does not schedule background work while busy, even after the idle threshold elapses", () => {
    const holdingPropState: LiveState = {
      ...dressedState,
      body: { ...baseBody, hands: "holdingProp", prop: "vibrator" },
    };
    const director = makeDirector(holdingPropState, 0);
    director.nextJob();
    director.tick(25_000, { busy: true });
    expect(director.getState().jobQueue).toEqual([]);
    director.tick(25_000, { busy: false });
    expect(director.getState().jobQueue).toEqual([
      {
        kind: "beat",
        beat: { id: "rest-1", intent: { type: "rest" }, attempt: 0 },
      },
    ]);
  });

  it("drops only the abandoned request's own queued beats", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting
    director.clipCompleted(
      clipResult({
        jobKind: "reply",
        followUps: [
          {
            id: "b1",
            intent: { type: "act", act: "gesture" },
            attempt: 0,
            requestId: "A",
          },
          { id: "rest-1", intent: { type: "rest" }, attempt: 0 },
        ],
        state: dressedState,
      }),
      1000,
    );
    const { job: replyB } = director.fanRequest(
      { text: "B", channel: "chat" },
      2000,
    );
    expect(director.getState().jobQueue).toEqual([
      {
        kind: "beat",
        beat: {
          id: "b1",
          intent: { type: "act", act: "gesture" },
          attempt: 0,
          requestId: "A",
        },
      },
      {
        kind: "beat",
        beat: { id: "rest-1", intent: { type: "rest" }, attempt: 0 },
      },
      replyB,
    ]);

    director.abandonRequest("A");

    expect(director.getState().jobQueue).toEqual([
      {
        kind: "beat",
        beat: { id: "rest-1", intent: { type: "rest" }, attempt: 0 },
      },
      replyB,
    ]);
  });

  it("registers a fan request as queued and marks it done once its own clip completes with no follow-ups", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting
    const { entry, job } = director.fanRequest(
      { text: "hi", channel: "chat" },
      1000,
    );
    expect(director.getState().requestStatuses[entry.id]).toBe("queued");
    expect(director.nextJob()).toEqual(job); // dispatch the reply; lastDispatchedJob = job
    director.clipCompleted(
      clipResult({ jobKind: "reply", followUps: [], state: dressedState }),
      2000,
    );
    expect(director.getState().requestStatuses[entry.id]).toBe("done");
  });

  it("does not mark a request done while its own follow-up beat is still queued", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting
    const { entry } = director.fanRequest(
      { text: "strip", channel: "chat" },
      1000,
    );
    director.nextJob(); // dispatch the reply
    const beat: PlannedBeat = {
      id: "b1",
      intent: { type: "act", act: "gesture" },
      attempt: 0,
      requestId: entry.id,
    };
    director.clipCompleted(
      clipResult({ jobKind: "reply", followUps: [beat], state: dressedState }),
      2000,
    );
    expect(director.getState().requestStatuses[entry.id]).toBe("queued");

    director.nextJob(); // dispatch the follow-up beat
    director.clipCompleted(
      clipResult({ jobKind: "beat", followUps: [], state: dressedState }),
      3000,
    );
    expect(director.getState().requestStatuses[entry.id]).toBe("done");
  });

  it("marks an abandoned request's status failed", () => {
    const director = makeDirector();
    director.nextJob();
    const { entry } = director.fanRequest(
      { text: "hi", channel: "chat" },
      1000,
    );
    director.abandonRequest(entry.id);
    expect(director.getState().requestStatuses[entry.id]).toBe("failed");
  });

  it("lets the caller drive generating/playing transitions via setRequestStatus", () => {
    const director = makeDirector();
    director.nextJob();
    const { entry } = director.fanRequest(
      { text: "hi", channel: "chat" },
      1000,
    );
    director.setRequestStatus(entry.id, "generating");
    expect(director.getState().requestStatuses[entry.id]).toBe("generating");
    director.setRequestStatus(entry.id, "playing");
    expect(director.getState().requestStatuses[entry.id]).toBe("playing");
  });

  it("ignores a duplicate clipCompleted for a clip it already committed", () => {
    const director = makeDirector();
    director.nextJob(); // consume greeting
    const beat: PlannedBeat = {
      id: "b1",
      intent: { type: "act", act: "gesture" },
      attempt: 0,
    };
    const result = clipResult({
      jobKind: "reply",
      followUps: [beat],
      state: dressedState,
    });
    director.clipCompleted(result, 1000);
    director.clipCompleted(result, 1000);
    expect(director.getState().jobQueue).toEqual([{ kind: "beat", beat }]);
  });
});
