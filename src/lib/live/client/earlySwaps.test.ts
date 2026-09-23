import { describe, expect, it, vi } from "vitest";
import { createEarlySwaps } from "./earlySwaps";

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

  it("swaps the reply whole when no second container is free", () => {
    const runSwap = vi.fn(() => new Promise<string>(() => {}));
    const early = createEarlySwaps(runSwap, {
      headFrames: 100,
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
