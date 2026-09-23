import type { SwapFrameRange } from "@/lib/live/client/api";
import type { ClipResult } from "@/lib/live/contract";

type SwapTarget = Pick<ClipResult, "videoUrl" | "jobKind">;

type SplitOptions = {
  headFrames: number;
  // Takes a second container for the rest's swap and returns its release, or null when none is free.
  reserve: () => (() => void) | null;
};

// Reply full swaps started from the clip route's render stream, keyed by the unswapped video url, for finalizeSwap to pick up.
export const createEarlySwaps = <T>(
  runSwap: (clip: SwapTarget, range?: SwapFrameRange) => Promise<T>,
  split?: SplitOptions,
) => {
  const swaps = new Map<string, Promise<T>>();
  // A split reply's frames from split.headFrames on, swapping beside its head.
  const rests = new Map<string, Promise<T>>();
  let inFlight = 0;
  return {
    start: (videoUrl: string) => {
      // One at a time: it runs outside the pipeline's swap slots, and Modal serves at most 4 containers.
      if (inFlight >= 1) {
        return;
      }
      inFlight += 1;
      const clip: SwapTarget = { videoUrl, jobKind: "reply" };
      const release = split?.reserve() ?? null;
      const swap = release
        ? runSwap(clip, { endFrame: split?.headFrames })
        : runSwap(clip);
      swaps.set(videoUrl, swap);
      if (release) {
        const rest = runSwap(clip, { startFrame: split?.headFrames });
        rests.set(videoUrl, rest);
        void rest.catch(() => undefined).finally(release);
      }
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
        rests.delete(url);
      }
    },
    take: (clip: SwapTarget): Promise<T> | undefined => {
      const swap = swaps.get(clip.videoUrl);
      swaps.delete(clip.videoUrl);
      return swap;
    },
    // A split reply's rest, taken beside its head; undefined when the reply was not split.
    takeRest: (clip: SwapTarget): Promise<T> | undefined => {
      const rest = rests.get(clip.videoUrl);
      rests.delete(clip.videoUrl);
      return rest;
    },
  };
};
