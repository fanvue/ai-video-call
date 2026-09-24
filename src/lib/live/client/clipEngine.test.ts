import { describe, expect, it } from "vitest";
import { CLIP_ENGINE_LABEL, clipEngineFor } from "./clipEngine";

describe("clipEngineFor", () => {
  it("labels a Wan-rendered clip Premium, a failed Wan call Swap fallback, and anything else Swap", () => {
    expect(
      clipEngineFor({
        premium: { status: "rendered", wanMs: 17_000, reason: null },
      }),
    ).toBe("premium");
    expect(
      clipEngineFor({
        premium: { status: "fallback", wanMs: 40_000, reason: "timeout: x" },
      }),
    ).toBe("swapFallback");
    expect(clipEngineFor({})).toBe("swap");
    expect(CLIP_ENGINE_LABEL.swapFallback).toBe("Swap fallback");
  });
});
