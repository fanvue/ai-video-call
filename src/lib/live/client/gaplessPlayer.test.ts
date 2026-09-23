import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GaplessPlayer,
  type ClipToPlay,
} from "@/lib/live/client/gaplessPlayer";

// Lets a test run the pre-frame-exact boundary (hidden early start, 320 ms dissolve).
const tunables = vi.hoisted(() => ({ frameExact: true }));
vi.mock("@/lib/live/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/live/contract")>();
  return {
    ...actual,
    LIVE_TUNABLES: {
      ...actual.LIVE_TUNABLES,
      get FRAME_EXACT_BOUNDARY() {
        return tunables.frameExact;
      },
    },
  };
});

type Listener = (event: { currentTarget: FakeVideo }) => void;

// Minimal stand-in for HTMLVideoElement: enough surface for the player's load/play/swap path.
class FakeVideo {
  src = "";
  style = { opacity: "", zIndex: "", transitionDuration: "", filter: "" };
  loop = false;
  muted = false;
  volume = 1;
  readyState = 2;
  duration = 10;
  currentTime = 0;
  paused = true;
  loadCalls = 0;
  playCalls = 0;
  // Override per test: a rejecting or never-resolving play() simulates a stalled incoming slot.
  playImpl: () => Promise<void> = () => Promise.resolve();
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.src = "";
    }
  }

  load(): void {
    this.loadCalls += 1;
    this.currentTime = 0;
  }

  play(): Promise<void> {
    this.playCalls += 1;
    return this.playImpl().then(() => {
      this.paused = false;
    });
  }

  pause(): void {
    this.paused = true;
  }

  fireTimeUpdate(currentTime: number): void {
    this.currentTime = currentTime;
    this.fire("timeupdate");
  }

  // Generic event dispatch: used to simulate loadeddata/canplaythrough/playing from tests.
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ currentTarget: this });
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

// Adds requestVideoFrameCallback so tests can exercise the rVFC-preferred confirmPlaying path.
class RvfcFakeVideo extends FakeVideo {
  private rvfcCallback: (() => void) | null = null;

  requestVideoFrameCallback(callback: () => void): number {
    this.rvfcCallback = callback;
    return 1;
  }

  cancelVideoFrameCallback(): void {
    this.rvfcCallback = null;
  }

  fireVideoFrame(): void {
    this.rvfcCallback?.();
  }
}

const clip = (id: string, loops = false, interrupts = false): ClipToPlay => ({
  id,
  videoUrl: `https://cdn.example/${id}.mp4`,
  durationSec: 10,
  hasSpeech: false,
  loops,
  interrupts,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("GaplessPlayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("performance", { now: () => 0 });
    tunables.frameExact = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const setup = (queue: ClipToPlay[]) => {
    const a = new FakeVideo();
    const b = new FakeVideo();
    const player = new GaplessPlayer({ onStatusChange: () => {} });
    const getNextClip = vi.fn(() => queue.shift() ?? null);
    player.setNextClipHandler(getNextClip);
    player.attach(
      a as unknown as HTMLVideoElement,
      b as unknown as HTMLVideoElement,
    );
    return { a, b, player, getNextClip };
  };

  it("keeps the clip preloaded into the vacated slot through the post-swap cleanup", async () => {
    const { a, b, player } = setup([clip("c1"), clip("c2"), clip("c3")]);
    player.start();
    await flush();
    expect(a.src).toBe(clip("c1").videoUrl);
    expect(a.style.opacity).toBe("1");
    expect(b.style.opacity).toBe("0");
    expect(b.src).toBe(clip("c2").videoUrl);

    // c1 reaches its swap point: c2 starts in b, c3 is preloaded into a.
    a.fireTimeUpdate(9.95);
    await flush();
    b.fire("playing");
    await flush();
    expect(b.paused).toBe(false);
    // The swapped-in slot must become the visible one or the viewer sees black.
    expect(b.style.opacity).toBe("1");
    // The incoming slot fades in on top; the outgoing stays opaque under it until the fade ends.
    expect(b.style.zIndex).toBe("-1");
    expect(a.style.zIndex).toBe("-2");
    expect(a.style.opacity).toBe("1");
    // Still showing c1's last frame under the fade: reloading it now is what flashed black in prod.
    expect(a.src).toBe(clip("c1").videoUrl);
    expect(a.loop).toBe(false);

    // Once the fade ends the outgoing slot is hidden, and only then takes the c3 preload.
    vi.advanceTimersByTime(500);
    expect(a.style.opacity).toBe("0");
    await flush();
    expect(a.src).toBe(clip("c3").videoUrl);

    // c2 ends: c3 plays from a instead of the stream dying.
    b.fireTimeUpdate(9.95);
    await flush();
    a.fire("playing");
    await flush();
    expect(a.paused).toBe(false);
    expect(player.getActiveSlot()).toBe("a");
    expect(player.getStatus()).toBe("playing");
  });

  it("plays the resolved (prefetched) source and releases it once the element is cleared", async () => {
    const a = new FakeVideo();
    const b = new FakeVideo();
    const released: string[] = [];
    const player = new GaplessPlayer({
      onStatusChange: () => {},
      resolveSource: (url) => Promise.resolve(`blob:${url}`),
      releaseSource: (src) => released.push(src),
    });
    const queue = [clip("c1"), clip("c2"), clip("c3")];
    player.setNextClipHandler(() => queue.shift() ?? null);
    player.attach(
      a as unknown as HTMLVideoElement,
      b as unknown as HTMLVideoElement,
    );
    player.start();
    await flush();
    await flush();
    expect(a.src).toBe(`blob:${clip("c1").videoUrl}`);
    expect(b.src).toBe(`blob:${clip("c2").videoUrl}`);

    a.fireTimeUpdate(9.95);
    await flush();
    b.fire("playing");
    await flush();
    vi.advanceTimersByTime(500);
    expect(released).toEqual([`blob:${clip("c1").videoUrl}`]);
  });

  it("reports a mid-play data stall on the on-screen clip with its duration", async () => {
    const a = new FakeVideo();
    const b = new FakeVideo();
    const stalls: { clipId: string; atSec: number; ms: number }[] = [];
    let nowMs = 0;
    vi.stubGlobal("performance", { now: () => nowMs });
    const player = new GaplessPlayer({
      onStatusChange: () => {},
      onStall: (detail) => stalls.push(detail),
    });
    const queue = [clip("c1")];
    player.setNextClipHandler(() => queue.shift() ?? null);
    player.attach(
      a as unknown as HTMLVideoElement,
      b as unknown as HTMLVideoElement,
    );
    player.start();
    await flush();
    a.currentTime = 4;
    a.fire("waiting");
    nowMs = 1200;
    a.fire("playing");
    b.fire("playing");
    expect(stalls).toEqual([{ clipId: "c1", atSec: 4, ms: 1200 }]);
  });

  it("keeps a looping clip playing when nothing else is ready, and swaps once something is", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const { a, b, player, getNextClip } = setup(queue);
    player.start();
    await flush();
    expect(a.loop).toBe(true);

    // Boundary with an empty buffer: no pause, no hold, the element loops natively.
    a.fireTimeUpdate(9.95);
    await flush();
    expect(a.paused).toBe(false);
    expect(player.getStatus()).toBe("playing");
    expect(getNextClip).toHaveBeenCalled();

    // A clip lands: it is preloaded and taken at the next boundary.
    queue.push(clip("c2"));
    player.checkForClip();
    await flush();
    expect(b.src).toBe(clip("c2").videoUrl);
    a.fireTimeUpdate(9.95);
    await flush();
    b.fire("playing");
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(b.loop).toBe(false);
  });

  it("a requested clip replaces the preloaded idle and cuts in mid-loop through a blur dissolve, returning the displaced idle", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true), clip("idle2", true)];
    const { a, b, player } = setup(queue);
    const returned: string[] = [];
    player.setClipReturnedHandler((id) => returned.push(id));
    player.setInterruptReadyHandler(() => queue.some((c) => c.interrupts));
    player.start();
    await flush();
    // idle2 is preloaded behind the loop; the loop is mid-way through.
    expect(b.src).toBe(clip("idle2").videoUrl);
    a.currentTime = 3;

    // The reply lands: it replaces the preloaded idle and cuts in without waiting for the wrap.
    queue.unshift(clip("reply", false, true));
    player.checkForClip();
    await flush();
    expect(returned).toEqual(["idle2"]);
    expect(b.src).toBe(clip("reply").videoUrl);
    expect(b.style.filter).toBe("blur(6px)");
    b.fire("playing");
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(b.paused).toBe(false);
    expect(b.style.opacity).toBe("1");
    expect(b.style.filter).toBe("");
    expect(a.style.filter).toBe("blur(6px)");
    expect(b.style.transitionDuration).toBe("450ms");
    vi.advanceTimersByTime(450);
    expect(a.style.opacity).toBe("0");
    expect(a.style.filter).toBe("");
  });

  it("defers a cut-in to the loop boundary when the idle is within CUT_IN_WAIT_MAX_SEC of wrapping, so the reply starts from the anchor pose", async () => {
    tunables.frameExact = false;
    const queue: ClipToPlay[] = [clip("loop1", true), clip("idle2", true)];
    const { a, b, player } = setup(queue);
    player.setInterruptReadyHandler(() => queue.some((c) => c.interrupts));
    player.start();
    await flush();
    a.fireTimeUpdate(9.5);
    await flush();

    queue.unshift(clip("reply", false, true));
    player.checkForClip();
    await flush();
    // Preloaded and warmed, but still behind the loop.
    expect(b.src).toBe(clip("reply").videoUrl);
    expect(player.getActiveSlot()).toBe("a");
    expect(a.style.opacity).toBe("1");

    // The wider cut-in lead catches the wrap that a 0.12 s window would miss between timeupdates.
    a.fireTimeUpdate(9.7);
    await flush();
    b.fire("playing");
    await flush();
    // Playing hidden: the reveal waits for the idle's last frame, not for play() to start.
    expect(b.paused).toBe(false);
    expect(player.getActiveSlot()).toBe("a");
    expect(a.style.opacity).toBe("1");
    a.fireTimeUpdate(9.92);
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(b.style.transitionDuration).toBe("320ms");
    vi.advanceTimersByTime(320);
    expect(a.style.opacity).toBe("0");
  });

  it("cuts a reply into a looping idle mid-motion at once instead of waiting out the loop", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const { a, b, player } = setup(queue);
    player.setInterruptReadyHandler(() => queue.some((c) => c.interrupts));
    player.start();
    await flush();
    a.fireTimeUpdate(2);
    await flush();

    queue.unshift(clip("reply", false, true));
    player.checkForClip();
    await flush();
    expect(b.src).toBe(clip("reply").videoUrl);
    b.fire("playing");
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(a.currentTime).toBe(2);
  });

  it("cuts a reply into an idle that has only just wrapped, instead of waiting for the next wrap", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const { a, b, player } = setup(queue);
    player.setInterruptReadyHandler(() => queue.some((c) => c.interrupts));
    player.start();
    await flush();
    a.fireTimeUpdate(0.3);
    await flush();

    queue.unshift(clip("reply", false, true));
    player.checkForClip();
    await flush();
    expect(b.src).toBe(clip("reply").videoUrl);
    b.fire("playing");
    await flush();
    expect(player.getActiveSlot()).toBe("b");
  });

  it("does not reveal a boundary swap on a still first frame: a preloaded readyState alone is not a presented frame", async () => {
    tunables.frameExact = false;
    const { a, b, player } = setup([clip("c1"), clip("c2")]);
    player.start();
    await flush();
    await flush(); // c2's preload settles so 9.7 s is a boundary swap, not a hold
    a.fireTimeUpdate(9.7);
    await flush();
    expect(b.paused).toBe(false);
    expect(player.getActiveSlot()).toBe("a");
    b.fire("playing");
    await flush();
    // The incoming clip is playing hidden until the outgoing one is on its last frame.
    expect(player.getActiveSlot()).toBe("a");
    a.fire("ended");
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(b.style.opacity).toBe("1");
  });

  it("reveals a boundary swap after REVEAL_TIMEOUT if the outgoing element never reports its end", async () => {
    tunables.frameExact = false;
    const { a, b, player } = setup([clip("c1"), clip("c2")]);
    player.start();
    await flush();
    await flush(); // c2's preload settles so 9.7 s is a boundary swap, not a hold
    a.fireTimeUpdate(9.7);
    await flush();
    b.fire("playing");
    await flush();
    expect(player.getActiveSlot()).toBe("a");
    vi.advanceTimersByTime(1500);
    await flush();
    expect(player.getActiveSlot()).toBe("b");
  });

  it("frame-exact boundary: keeps the incoming clip on frame 0 until the outgoing one is on its last frame, then hard-cuts", async () => {
    const { a, b, player } = setup([clip("c1"), clip("c2")]);
    player.start();
    await flush();
    await flush(); // c2's preload settles so 9.7 s is a boundary swap, not a hold
    const warmPlays = b.playCalls;
    a.fireTimeUpdate(9.7);
    await flush();
    // Inside the lead but not on the last frame: nothing has started, so no head frames are skipped.
    expect(b.playCalls).toBe(warmPlays);
    expect(b.paused).toBe(true);
    expect(a.loop).toBe(false);
    a.fireTimeUpdate(9.92);
    await flush();
    expect(b.playCalls).toBe(warmPlays);
    a.fireTimeUpdate(9.96);
    await flush();
    expect(b.playCalls).toBe(warmPlays + 1);
    expect(player.getActiveSlot()).toBe("a");
    b.fire("playing");
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(b.style.opacity).toBe("1");
    expect(b.style.transitionDuration).toBe("0ms");
    vi.advanceTimersByTime(0);
    expect(a.style.opacity).toBe("0");
  });

  it("frame-exact boundary: stops a looping idle on its last frame instead of wrapping, and hard-cuts a deferred cut-in", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const { a, b, player } = setup(queue);
    player.setInterruptReadyHandler(() => queue.some((c) => c.interrupts));
    player.start();
    await flush();
    expect(a.loop).toBe(true);
    a.fireTimeUpdate(9.5);
    await flush();
    queue.unshift(clip("reply", false, true));
    player.checkForClip();
    await flush();
    a.fireTimeUpdate(9.7);
    await flush();
    expect(a.loop).toBe(false);
    expect(player.getActiveSlot()).toBe("a");
    a.fire("ended");
    await flush();
    b.fire("playing");
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(b.style.transitionDuration).toBe("0ms");
    expect(b.style.filter).toBe("");
  });

  it("frame-exact boundary: a looping idle goes back to looping when the incoming clip never produces a frame", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true), clip("idle2", true)];
    const { a, b, player } = setup(queue);
    player.start();
    await flush();
    player.checkForClip();
    await flush();
    b.playImpl = () => Promise.reject(new Error("decode"));
    a.fireTimeUpdate(9.7);
    await flush();
    a.fireTimeUpdate(9.96);
    await flush();
    await flush();
    expect(player.getActiveSlot()).toBe("a");
    expect(a.loop).toBe(true);
    expect(a.paused).toBe(false);
    expect(player.getStatus()).toBe("playing");
  });

  it("resumes an active element that was paused from under it", async () => {
    const { a, player } = setup([clip("c1")]);
    player.start();
    await flush();
    expect(a.paused).toBe(false);
    a.paused = true;
    (
      player as unknown as { nudgeIfStalled: (el: FakeVideo) => void }
    ).nudgeIfStalled(a);
    await flush();
    expect(a.paused).toBe(false);
  });

  it("holds for a still-loading preload instead of pulling another clip from the buffer", async () => {
    const { a, b, player, getNextClip } = setup([clip("c1"), clip("c2")]);
    // c2 will not become playable until its loadeddata fires.
    b.readyState = 0;
    player.start();
    await flush();
    expect(b.src).toBe(clip("c2").videoUrl);
    const pullsBefore = getNextClip.mock.calls.length;

    a.fireTimeUpdate(9.95);
    await flush();
    expect(getNextClip.mock.calls.length).toBe(pullsBefore);
    expect(player.getStatus()).toBe("holding");
  });

  it("cuts to a same-look fallback idle when a one-shot clip ends with nothing chained ready, instead of holding", async () => {
    const { a, b, player, getNextClip } = setup([clip("reply")]);
    const getFallbackClip = vi.fn(() => clip("oldIdle", true));
    player.setFallbackClipHandler(getFallbackClip);
    player.start();
    await flush();
    expect(getNextClip).toHaveBeenCalled();
    expect(b.src).toBe("");

    a.fireTimeUpdate(9.9);
    await flush();
    expect(getFallbackClip).toHaveBeenCalledTimes(1);
    expect(b.src).toBe(clip("oldIdle").videoUrl);
    a.fireTimeUpdate(9.95);
    await flush();
    b.fire("playing");
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(player.getStatus()).toBe("playing");
    expect(b.loop).toBe(true);
  });

  it("never asks for a fallback while a looping clip is on screen", async () => {
    const { a, player } = setup([clip("loop1", true)]);
    const getFallbackClip = vi.fn(() => clip("oldIdle", true));
    player.setFallbackClipHandler(getFallbackClip);
    player.start();
    await flush();
    a.fireTimeUpdate(9.95);
    await flush();
    expect(getFallbackClip).not.toHaveBeenCalled();
    expect(player.getStatus()).toBe("playing");
  });

  it("aborts the swap when the incoming clip never becomes playable, keeping the outgoing one live", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const { a, b, player } = setup(queue);
    const returned: string[] = [];
    const started: string[] = [];
    player.setClipReturnedHandler((id) => returned.push(id));
    player.setClipStartedHandler((id) => started.push(id));
    player.start();
    await flush();
    started.length = 0; // drop the initial clip-started call

    b.readyState = 0; // never fires loadeddata/canplaythrough
    const stalled = clip("stalled");
    queue.push(stalled);
    player.checkForClip();
    await flush();
    expect(b.src).toBe(stalled.videoUrl);

    vi.advanceTimersByTime(8000); // waitForPlayable's readiness timeout
    await flush();

    expect(returned).toEqual(["stalled"]);
    expect(started).toEqual([]);
    expect(player.getActiveSlot()).toBe("a");
    expect(a.style.opacity).toBe("1");
    expect(a.paused).toBe(false);
  });

  it("drops a clip that fails readiness twice instead of requeueing it forever", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const { b, player } = setup(queue);
    const returned: string[] = [];
    player.setClipReturnedHandler((id) => returned.push(id));
    player.start();
    await flush();

    b.readyState = 0;
    const stalled = clip("stalled");
    queue.push(stalled);
    player.checkForClip();
    await flush();
    vi.advanceTimersByTime(8000);
    await flush();
    expect(returned).toEqual(["stalled"]);

    // The pipeline hands the same clip straight back; it fails again and is now dropped.
    queue.push(stalled);
    player.checkForClip();
    await flush();
    vi.advanceTimersByTime(8000);
    await flush();
    expect(returned).toEqual(["stalled"]);
    expect(player.getActiveSlot()).toBe("a");
  });

  it("swaps only after incoming.play() resolves and fires playing, exactly once", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const { a, b, player } = setup(queue);
    const started: string[] = [];
    player.setClipStartedHandler((id) => started.push(id));
    player.setInterruptReadyHandler(() => true);
    player.start();
    await flush();
    started.length = 0;

    b.readyState = 0;
    const incoming = clip("incoming", false, true);
    queue.push(incoming);
    player.checkForClip(); // cuts in: preloads "incoming" over the looping "loop1"
    await flush();
    expect(b.src).toBe(incoming.videoUrl);
    expect(player.getActiveSlot()).toBe("a");

    b.fire("loadeddata"); // preload's readiness resolves; the cut-in waits for the loop's wrap
    await flush();
    a.fireTimeUpdate(9.7); // wrap: performSwap awaits incoming.play()
    await flush();
    expect(player.getActiveSlot()).toBe("a"); // play() has no decoded frame yet
    expect(started).toEqual([]);

    b.fire("playing"); // confirms a decoded frame; swap completes exactly once
    await flush();
    a.fireTimeUpdate(9.92);
    await flush();

    expect(player.getActiveSlot()).toBe("b");
    expect(started).toEqual(["incoming"]);
    expect(b.style.opacity).toBe("1");
    expect(b.paused).toBe(false);
  });

  it("warms the preloaded slot with a muted play and pause, rewound to 0", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true), clip("next", false)];
    const { b, player } = setup(queue);
    player.start();
    await flush();
    player.checkForClip();
    await flush();
    expect(b.src).toBe(clip("next").videoUrl);
    expect(b.playCalls).toBe(1);
    expect(b.paused).toBe(true);
    expect(b.muted).toBe(true);
    expect(b.currentTime).toBe(0);
    expect(player.getActiveSlot()).toBe("a");
  });

  it("does not pause an element whose boundary swap is already in flight when the warm-up resolves late", async () => {
    tunables.frameExact = false;
    const queue: ClipToPlay[] = [clip("one", false), clip("two", false)];
    const { a, b, player } = setup(queue);
    player.start();
    await flush();
    let resolveWarm: () => void = () => {};
    b.playImpl = () => new Promise<void>((resolve) => (resolveWarm = resolve));
    player.checkForClip();
    await flush();
    expect(b.playCalls).toBe(1);
    // Boundary: performSwap calls play() again and waits for a presented frame.
    b.playImpl = () => Promise.resolve();
    a.fireTimeUpdate(9.9);
    await flush();
    expect(b.playCalls).toBe(2);
    resolveWarm();
    await flush();
    b.fire("playing");
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(b.paused).toBe(false);
  });

  it("ignores a stale canplaythrough from an earlier, superseded preload", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const { a, b, player } = setup(queue);
    const started: string[] = [];
    player.setClipStartedHandler((id) => started.push(id));
    player.start();
    await flush();
    started.length = 0;

    const preload = (c: ClipToPlay) =>
      (
        player as unknown as { preload: (c: ClipToPlay) => Promise<void> }
      ).preload(c);

    b.readyState = 0;
    const abandoned = clip("abandoned", false, true);
    void preload(abandoned); // starts loading, never resolves
    await flush();
    expect(b.src).toBe(abandoned.videoUrl);

    // A second preload starts before the first ever resolves, superseding it. "abandoned"'s
    // waitForPlayable listeners are left dangling on the shared element b.
    const replacement = clip("replacement", false, true);
    void preload(replacement);
    await flush();
    expect(b.src).toBe(replacement.videoUrl);

    // The abandoned load's canplaythrough arrives late, alongside the current one that is
    // genuinely waiting on the same shared element.
    b.fire("canplaythrough");
    await flush();
    a.fireTimeUpdate(9.7); // the loop wraps: the current preload's swap starts
    await flush();
    b.fire("playing"); // confirmPlaying for the (correct) in-flight swap
    await flush();
    a.fireTimeUpdate(9.92);
    await flush();

    // Only the still-current clip ("replacement") is ever shown or reported started; the stale
    // continuation for "abandoned" was ignored rather than flipping slots under the wrong id.
    expect(started).toEqual(["replacement"]);
    expect(player.getActiveSlot()).toBe("b");
    expect(b.src).toBe(replacement.videoUrl);
  });

  it("prefers requestVideoFrameCallback over the playing event when the element supports it", async () => {
    const a = new RvfcFakeVideo();
    const b = new RvfcFakeVideo();
    const player = new GaplessPlayer({ onStatusChange: () => {} });
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const getNextClip = vi.fn(() => queue.shift() ?? null);
    player.setNextClipHandler(getNextClip);
    player.setInterruptReadyHandler(() => true);
    const started: string[] = [];
    player.setClipStartedHandler((id) => started.push(id));
    player.attach(
      a as unknown as HTMLVideoElement,
      b as unknown as HTMLVideoElement,
    );
    player.start();
    await flush();
    started.length = 0;

    b.readyState = 0;
    const incoming = clip("incoming", false, true);
    queue.push(incoming);
    player.checkForClip();
    await flush();
    b.fire("loadeddata");
    await flush();
    a.fireTimeUpdate(9.7); // the loop wraps: the swap starts
    await flush();
    expect(player.getActiveSlot()).toBe("a");

    b.fire("playing"); // ignored: rVFC is preferred once available, this alone must not swap
    await flush();
    a.fireTimeUpdate(9.92);
    await flush();
    expect(player.getActiveSlot()).toBe("a");
    expect(started).toEqual([]);

    b.fireVideoFrame(); // a real presented frame confirms the swap
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(started).toEqual(["incoming"]);
  });
});
