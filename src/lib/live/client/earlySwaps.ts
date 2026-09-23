import type { SwapFrameRange } from "@/lib/live/client/api";
import type { ClipResult } from "@/lib/live/contract";

type SwapTarget = Pick<ClipResult, "videoUrl" | "jobKind">;

type EarlySwapKind = "reply" | "greeting";

type SplitOptions = {
  headFrames: number;
  greetingHeadFrames: number;
  // Takes a second container for the rest's swap and returns its release, or null when none is free.
  reserve: () => (() => void) | null;
};

// Reply and greeting full swaps started from the clip route's render stream, keyed by the unswapped video url, for finalizeSwap to pick up.
export const createEarlySwaps = <T>(
  runSwap: (clip: SwapTarget, range?: SwapFrameRange) => Promise<T>,
  split?: SplitOptions,
) => {
  const swaps = new Map<string, Promise<T>>();
  // A split clip's frames from its head's end on, swapping beside its head.
  const rests = new Map<string, Promise<T>>();
  let inFlight = 0;
  return {
    start: (videoUrl: string, jobKind: EarlySwapKind = "reply") => {
      // One at a time: it runs outside the pipeline's swap slots, and Modal serves at most 4 containers.
      if (inFlight >= 1) {
        return;
      }
      inFlight += 1;
      const clip: SwapTarget = { videoUrl, jobKind };
      const headFrames =
        jobKind === "greeting" ? split?.greetingHeadFrames : split?.headFrames;
      const release = split?.reserve() ?? null;
      const swap = release
        ? runSwap(clip, { endFrame: headFrames })
        : runSwap(clip);
      swaps.set(videoUrl, swap);
      if (release) {
        const rest = runSwap(clip, { startFrame: headFrames });
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
    // A split clip's rest, taken beside its head; undefined when it was not split.
    takeRest: (clip: SwapTarget): Promise<T> | undefined => {
      const rest = rests.get(clip.videoUrl);
      rests.delete(clip.videoUrl);
      return rest;
    },
  };
};

// A chain clip with no early swap still splits when a container is free, so it plays once its head lands: prod (Sept 23, hhg4dahy1) swapped follow-up beats whole in 12 to 15 s and held her frozen 1.7 to 6.8 s after the reply before them.
export const splitSwap = <T>(
  runSwap: (clip: SwapTarget, range?: SwapFrameRange) => Promise<T>,
  clip: SwapTarget,
  headFrames: number,
  reserve: () => (() => void) | null,
): Promise<{ head: T; rest?: Promise<T> }> => {
  const release = reserve();
  if (!release) {
    return runSwap(clip).then((head) => ({ head }));
  }
  const head = runSwap(clip, { endFrame: headFrames });
  const rest = runSwap(clip, { startFrame: headFrames });
  void rest.catch(() => undefined).finally(release);
  return head.then((swapped) => ({ head: swapped, rest }));
};
