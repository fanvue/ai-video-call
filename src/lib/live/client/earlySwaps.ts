import type { ClipResult } from "@/lib/live/contract";

type SwapTarget = Pick<ClipResult, "videoUrl" | "jobKind">;

// Reply full swaps started from the clip route's render stream, keyed by the unswapped video url, for finalizeSwap to pick up.
export const createEarlySwaps = <T>(runSwap: (clip: SwapTarget) => Promise<T>) => {
  const swaps = new Map<string, Promise<T>>();
  let inFlight = 0;
  return {
    start: (videoUrl: string) => {
      // One at a time: it runs outside the pipeline's swap slots, and Modal serves at most 4 containers.
      if (inFlight >= 1) {
        return;
      }
      inFlight += 1;
      const swap = runSwap({ videoUrl, jobKind: "reply" });
      swaps.set(videoUrl, swap);
      void swap
        .catch(() => undefined)
        .finally(() => {
          inFlight -= 1;
        });
      // A clip rejected after rendering never reaches finalizeSwap, so its entry must not pile up.
      for (const url of swaps.keys()) {
        if (swaps.size <= 2) {
          break;
        }
        swaps.delete(url);
      }
    },
    take: (clip: SwapTarget): Promise<T> | undefined => {
      const swap = swaps.get(clip.videoUrl);
      swaps.delete(clip.videoUrl);
      return swap;
    },
  };
};
