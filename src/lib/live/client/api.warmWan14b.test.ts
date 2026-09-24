import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// Fresh module per test: the in-flight warm-up is module state.
const load = async () => {
  vi.resetModules();
  return (await import("./api")).warmWan14b;
};

describe("warmWan14b", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares one call between the setup screen and the session start, so one container boots", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const warmWan14b = await load();
    const first = warmWan14b();
    const second = warmWan14b();
    answer(json({ warm: true }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/live/wan14bWarm",
      expect.objectContaining({ method: "POST" }),
    ]);
  });

  it("reuses a ready container for 4 minutes, then asks again", async () => {
    const fetchMock = vi.fn(async () => json({ warm: true }));
    vi.stubGlobal("fetch", fetchMock);
    const warmWan14b = await load();
    await warmWan14b();
    vi.advanceTimersByTime(239_000);
    await warmWan14b();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await warmWan14b();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves false on a failure and lets the next call retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(json({ warm: true }));
    vi.stubGlobal("fetch", fetchMock);
    const warmWan14b = await load();
    expect(await warmWan14b()).toBe(false);
    expect(await warmWan14b()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
