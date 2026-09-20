import { describe, expect, it } from "vitest";
import {
  createSeededRandom,
  MAX_ROSTER,
  MAX_ROSTER_JUMP,
  MIN_ROSTER,
  RoomSim,
  type RoomSimTickContext,
} from "./roomSim";
import type { LiveState, TipMenuItem } from "@/lib/live/contract";

const baseBody = {
  pose: "sitting" as const,
  facing: "camera" as const,
  hands: "free" as const,
  contact: "none" as const,
  prop: "none" as const,
  framing: "medium" as const,
};

const liveState: LiveState = {
  wardrobe: {
    top: { on: true, description: "tank top" },
    bottom: { on: true, description: "shorts" },
    bra: { on: true, description: "bra" },
    panties: { on: true, description: "panties" },
    removedOrder: [],
  },
  body: baseBody,
  baselineBody: baseBody,
  world: "settling in",
  surroundings: "a bedroom",
};

const tipMenu: TipMenuItem[] = [
  { id: "wave", label: "Wave", request: "wave at me", priceCents: 100 },
];

const ctx = (overrides: Partial<RoomSimTickContext>): RoomSimTickContext => ({
  nowMs: 0,
  liveState,
  systemIdle: true,
  tipMenu,
  ...overrides,
});

describe("RoomSim determinism", () => {
  it("produces identical roster and events for the same seed and tick sequence", () => {
    const run = () => {
      const sim = new RoomSim({ rng: createSeededRandom(42) });
      const events = [];
      for (let t = 0; t <= 30_000; t += 1000) {
        events.push(sim.tick(ctx({ nowMs: t })));
      }
      return { viewers: sim.getViewers(), events };
    };
    const a = run();
    const b = run();
    expect(a.viewers).toEqual(b.viewers);
    expect(a.events).toEqual(b.events);
  });

  it("starts within the roster bounds and never jumps by more than MAX_ROSTER_JUMP per tick", () => {
    const sim = new RoomSim({ rng: createSeededRandom(7) });
    expect(sim.getViewerCount()).toBeGreaterThanOrEqual(MIN_ROSTER);
    expect(sim.getViewerCount()).toBeLessThanOrEqual(MAX_ROSTER);

    let previous = sim.getViewerCount();
    for (let t = 0; t <= 120_000; t += 1000) {
      const result = sim.tick(ctx({ nowMs: t }));
      expect(result.viewerCount).toBeGreaterThanOrEqual(MIN_ROSTER);
      expect(result.viewerCount).toBeLessThanOrEqual(MAX_ROSTER);
      expect(Math.abs(result.viewerCount - previous)).toBeLessThanOrEqual(
        MAX_ROSTER_JUMP,
      );
      previous = result.viewerCount;
    }
  });
});

describe("RoomSim viewer requests", () => {
  it("fires within the configured cadence window while the system is idle", () => {
    const sim = new RoomSim({
      rng: createSeededRandom(1),
      viewerRequestIntervalMsRange: [5_000, 5_000],
    });
    let firstRequestAtMs: number | null = null;
    for (let t = 0; t <= 6_000; t += 1000) {
      const result = sim.tick(ctx({ nowMs: t }));
      if (result.viewerRequest && firstRequestAtMs === null) {
        firstRequestAtMs = t;
      }
    }
    expect(firstRequestAtMs).not.toBeNull();
    expect(firstRequestAtMs).toBeGreaterThanOrEqual(5_000);
  });

  it("never emits a viewer request while the system is not idle", () => {
    const sim = new RoomSim({
      rng: createSeededRandom(2),
      viewerRequestIntervalMsRange: [1_000, 1_000],
    });
    for (let t = 0; t <= 20_000; t += 1000) {
      const result = sim.tick(ctx({ nowMs: t, systemIdle: false }));
      expect(result.viewerRequest).toBeNull();
    }
  });

  it("draws requests from the tip menu or the generic catalog, tagged with tipCents only for tip picks", () => {
    const sim = new RoomSim({
      rng: createSeededRandom(3),
      viewerRequestIntervalMsRange: [1_000, 1_000],
    });
    const seen = { tipped: false, untipped: false };
    for (let t = 0; t <= 40_000; t += 1000) {
      const result = sim.tick(ctx({ nowMs: t }));
      if (!result.viewerRequest) {
        continue;
      }
      if (result.viewerRequest.tipCents !== undefined) {
        seen.tipped = true;
        expect(result.viewerRequest.text).toBe(tipMenu[0]?.request);
        expect(result.viewerRequest.tipCents).toBe(tipMenu[0]?.priceCents);
      } else {
        seen.untipped = true;
      }
    }
    expect(seen.tipped || seen.untipped).toBe(true);
  });
});

describe("RoomSim reactToClip", () => {
  it("only references garments and props actually present in LiveState", () => {
    const sim = new RoomSim({ rng: createSeededRandom(9) });
    sim.tick(ctx({ nowMs: 0 }));
    const strippedState: LiveState = {
      ...liveState,
      wardrobe: {
        ...liveState.wardrobe,
        top: { on: false, description: "tank top" },
      },
      body: { ...baseBody, prop: "vibrator" },
    };
    const messages = sim.reactToClip(
      { jobKind: "reply", state: strippedState },
      1000,
    );
    for (const message of messages) {
      expect(
        message.text.includes("tank top") || message.text.includes("vibrator"),
      ).toBe(true);
    }
  });

  it("produces no reaction when nothing changed and no tip was paid", () => {
    const sim = new RoomSim({ rng: createSeededRandom(11) });
    const messages = sim.reactToClip({ jobKind: "idle", state: liveState }, 0);
    expect(messages).toEqual([]);
  });
});
