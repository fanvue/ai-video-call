import { describe, expect, it, vi } from "vitest";
import { createEarlySwaps, splitSwap } from "./earlySwaps";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("createEarlySwaps", () => {
  it("finalizeSwap reuses the swap started at render instead of starting a second one", async () => {
    const pending = deferred<string>();
    const runSwap = vi.fn(() => pending.promise);
    const early = createEarlySwaps(runSwap);

    early.start("https://example.com/raw.mp4");
    const taken = early.take({
      videoUrl: "https://example.com/raw.mp4",
      jobKind: "reply",
    });
    pending.resolve("swapped");

    await expect(taken).resolves.toBe("swapped");
    expect(runSwap).toHaveBeenCalledTimes(1);
    expect(runSwap).toHaveBeenCalledWith({
      videoUrl: "https://example.com/raw.mp4",
      jobKind: "reply",
    });
  });

  it("a clip with no early swap gets nothing, and one is only taken once", () => {
    const early = createEarlySwaps(vi.fn(() => new Promise<string>(() => {})));
    early.start("https://example.com/a.mp4");
    expect(
      early.take({ videoUrl: "https://example.com/b.mp4", jobKind: "idle" }),
    ).toBeUndefined();
    expect(
      early.take({ videoUrl: "https://example.com/a.mp4", jobKind: "reply" }),
    ).toBeDefined();
    expect(
      early.take({ videoUrl: "https://example.com/a.mp4", jobKind: "reply" }),
    ).toBeUndefined();
  });

  it("runs at most one early swap at a time, freeing the slot when it settles, failure included", async () => {
    const first = deferred<string>();
    const runSwap = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(new Promise<string>(() => {}));
    const early = createEarlySwaps(runSwap);

    early.start("https://example.com/a.mp4");
    early.start("https://example.com/b.mp4");
    expect(runSwap).toHaveBeenCalledTimes(1);

    first.reject(new Error("Modal 503"));
    await first.promise.catch(() => undefined);
    await Promise.resolve();
    early.start("https://example.com/c.mp4");
    expect(runSwap).toHaveBeenCalledTimes(2);
    await expect(
      early.take({ videoUrl: "https://example.com/a.mp4", jobKind: "reply" }),
    ).rejects.toThrow("Modal 503");
  });

  it("splits a reply across two containers when one is free, releasing it once the rest settles", async () => {
    const rest = deferred<string>();
    const runSwap = vi
      .fn<
        (
          clip: unknown,
          range?: { startFrame?: number; endFrame?: number },
        ) => Promise<string>
      >()
      .mockImplementation((_clip, range) =>
        range?.startFrame !== undefined
          ? rest.promise
          : Promise.resolve("head"),
      );
    const release = vi.fn();
    const early = createEarlySwaps(runSwap, {
      headFrames: 100,
      greetingHeadFrames: 150,
      reserve: () => release,
    });
    const clip = {
      videoUrl: "https://example.com/raw.mp4",
      jobKind: "reply" as const,
    };

    early.start(clip.videoUrl);
    expect(runSwap).toHaveBeenCalledWith(clip, { endFrame: 100 });
    expect(runSwap).toHaveBeenCalledWith(clip, { startFrame: 100 });
    await expect(early.take(clip)).resolves.toBe("head");
    const taken = early.takeRest(clip);
    expect(release).not.toHaveBeenCalled();
    rest.reject(new Error("Modal 503"));
    await expect(taken).rejects.toThrow("Modal 503");
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("splits the greeting at its own longer head, as a greeting swap", () => {
    const runSwap = vi.fn(() => new Promise<string>(() => {}));
    const early = createEarlySwaps(runSwap, {
      headFrames: 100,
      greetingHeadFrames: 150,
      reserve: () => () => {},
    });
    const clip = {
      videoUrl: "https://example.com/greeting.mp4",
      jobKind: "greeting" as const,
    };

    early.start(clip.videoUrl, "greeting");
    expect(runSwap).toHaveBeenCalledWith(clip, { endFrame: 150 });
    expect(runSwap).toHaveBeenCalledWith(clip, { startFrame: 150 });
    expect(early.takeRest(clip)).toBeDefined();
  });

  it("swaps the reply whole when no second container is free", () => {
    const runSwap = vi.fn(() => new Promise<string>(() => {}));
    const early = createEarlySwaps(runSwap, {
      headFrames: 100,
      greetingHeadFrames: 150,
      reserve: () => null,
    });
    const clip = {
      videoUrl: "https://example.com/raw.mp4",
      jobKind: "reply" as const,
    };

    early.start(clip.videoUrl);
    expect(runSwap).toHaveBeenCalledTimes(1);
    expect(runSwap).toHaveBeenCalledWith(clip);
    expect(early.takeRest(clip)).toBeUndefined();
  });
});

describe("splitSwap", () => {
  const beat = {
    videoUrl: "https://example.com/beat.mp4",
    jobKind: "beat" as const,
  };

  it("swaps a chain clip's head and rest on two containers, resolving on the head and releasing once the rest settles", async () => {
    const rest = deferred<string>();
    const runSwap = vi
      .fn<
        (
          clip: unknown,
          range?: { startFrame?: number; endFrame?: number },
        ) => Promise<string>
      >()
      .mockImplementation((_clip, range) =>
        range?.startFrame !== undefined
          ? rest.promise
          : Promise.resolve("head"),
      );
    const release = vi.fn();

    const split = await splitSwap(runSwap, beat, 100, () => release);
    expect(runSwap).toHaveBeenCalledWith(beat, { endFrame: 100 });
    expect(runSwap).toHaveBeenCalledWith(beat, { startFrame: 100 });
    expect(split.head).toBe("head");
    expect(release).not.toHaveBeenCalled();
    rest.resolve("rest");
    await expect(split.rest).resolves.toBe("rest");
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("swaps a chain clip whole when no container is free for its rest", async () => {
    const runSwap = vi.fn(() => Promise.resolve("whole"));

    const split = await splitSwap(runSwap, beat, 100, () => null);
    expect(runSwap).toHaveBeenCalledTimes(1);
    expect(runSwap).toHaveBeenCalledWith(beat);
    expect(split).toEqual({ head: "whole" });
  });

  it("releases the rest's container when the rest fails", async () => {
    const runSwap = vi
      .fn<
        (
          clip: unknown,
          range?: { startFrame?: number; endFrame?: number },
        ) => Promise<string>
      >()
      .mockImplementation((_clip, range) =>
        range?.startFrame !== undefined
          ? Promise.reject(new Error("Modal 503"))
          : Promise.resolve("head"),
      );
    const release = vi.fn();

    const split = await splitSwap(runSwap, beat, 100, () => release);
    await expect(split.rest).rejects.toThrow("Modal 503");
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
