import { describe, expect, it } from "vitest";
import { formatQueueLabel } from "./QueueStrip";
import type { QueueStripEntry } from "@/lib/live/client/useLiveSession";

describe("formatQueueLabel", () => {
  it("returns null when nothing is current", () => {
    expect(formatQueueLabel(null, 0)).toBeNull();
  });

  it("labels the current act and owner, with a queued count when present", () => {
    const current: QueueStripEntry = { kind: "reply", owner: { type: "fan" } };
    expect(formatQueueLabel(current, 0)).toBe("Now: Replying for you");
    expect(formatQueueLabel(current, 2)).toBe(
      "Now: Replying for you · 2 queued",
    );
  });

  it("shows a failed state instead of the act label, never leaving the slot looking queued", () => {
    const current: QueueStripEntry = {
      kind: "reply",
      owner: { type: "viewer", handle: "kdub" },
      requestId: "r1",
    };
    expect(formatQueueLabel(current, 0, "failed")).toBe(
      "Couldn't finish that one for @kdub — retry?",
    );
  });
});
