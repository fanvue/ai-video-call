import type { ClipResult } from "@/lib/live/contract";

// Which engine made a clip, for the Premium session badge: idles are swap by design, a failed Wan call is a fallback.
export type ClipEngine = "premium" | "swapFallback" | "swap";

export const clipEngineFor = (
  result: Pick<ClipResult, "premium">,
): ClipEngine =>
  result.premium?.status === "rendered"
    ? "premium"
    : result.premium?.status === "fallback"
      ? "swapFallback"
      : "swap";

export const CLIP_ENGINE_LABEL: Record<ClipEngine, string> = {
  premium: "Premium",
  swapFallback: "Swap fallback",
  swap: "Swap",
};
