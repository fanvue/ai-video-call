import { describe, expect, it } from "vitest";
import {
  HELD_REPLY_MAX_WAIT_MS,
  HELD_REPLY_TYPING_FLOOR_MS,
  type PendingReveal,
  type PlayingClip,
  replyRevealDue,
} from "./replyReveal";

const pending = (overrides: Partial<PendingReveal> = {}): PendingReveal => ({
  clipId: "reply",
  requestId: "r1",
  text: "mm ok",
  channel: "chat",
  typingLeadSec: 2,
  holdForAction: false,
  replySeen: false,
  readyAtMs: 0,
  ...overrides,
});

const playing = (overrides: Partial<PlayingClip> = {}): PlayingClip => ({
  clipId: "reply",
  currentTimeSec: 0,
  requestId: "r1",
  setupOnly: false,
  idle: false,
  ...overrides,
});

const afterFloor = HELD_REPLY_TYPING_FLOOR_MS;

describe("replyRevealDue", () => {
  it("an action reply reveals on its own clip once the typing lead has played", () => {
    const p = pending();
    expect(replyRevealDue(p, playing({ currentTimeSec: 1 }), 0)).toBe(false);
    expect(replyRevealDue(p, playing({ currentTimeSec: 2 }), 0)).toBe(true);
  });

  it("an action reply ignores other clips", () => {
    expect(
      replyRevealDue(pending(), playing({ clipId: "other" }), afterFloor),
    ).toBe(false);
  });

  it("a setup reply holds through its own clip and reveals on the request's action clip", () => {
    const p = pending({ holdForAction: true });
    expect(
      replyRevealDue(p, playing({ currentTimeSec: 9 }), afterFloor),
    ).toBe(false);
    expect(p.replySeen).toBe(true);
    expect(
      replyRevealDue(p, playing({ clipId: "action" }), afterFloor),
    ).toBe(true);
  });

  it("a setup reply does not reveal before its own clip has been seen", () => {
    const p = pending({ holdForAction: true });
    expect(
      replyRevealDue(p, playing({ clipId: "action" }), afterFloor),
    ).toBe(false);
  });

  it("idle filler and another setup step of the same request keep holding", () => {
    const p = pending({ holdForAction: true, replySeen: true });
    expect(
      replyRevealDue(
        p,
        playing({ clipId: "filler", requestId: null, idle: true }),
        afterFloor,
      ),
    ).toBe(false);
    expect(
      replyRevealDue(p, playing({ clipId: "step2", setupOnly: true }), afterFloor),
    ).toBe(false);
  });

  it("a held reply still waits out ~3 s of typing even if the action clip is already up", () => {
    const p = pending({ holdForAction: true, replySeen: true, readyAtMs: 1_000 });
    expect(
      replyRevealDue(p, playing({ clipId: "action" }), 1_000 + afterFloor - 1),
    ).toBe(false);
    expect(
      replyRevealDue(p, playing({ clipId: "action" }), 1_000 + afterFloor),
    ).toBe(true);
  });

  it("another request's clip releases a held reply whose action never came", () => {
    const p = pending({ holdForAction: true, replySeen: true });
    expect(
      replyRevealDue(p, playing({ clipId: "next", requestId: "r2" }), afterFloor),
    ).toBe(true);
  });

  it("a held reply lands after the max wait even over idle filler", () => {
    const p = pending({ holdForAction: true, replySeen: true });
    expect(
      replyRevealDue(
        p,
        playing({ clipId: "filler", requestId: null, idle: true }),
        HELD_REPLY_MAX_WAIT_MS,
      ),
    ).toBe(true);
  });
});
