import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GaplessPlayer,
  type ClipToPlay,
} from "@/lib/live/client/gaplessPlayer";

type Listener = (event: { currentTarget: FakeVideo }) => void;

// Minimal stand-in for HTMLVideoElement: enough surface for the player's load/play/swap path.
class FakeVideo {
  src = "";
  style: { opacity: string } = { opacity: "" };
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
    expect(b.paused).toBe(false);
    // The swapped-in slot must become the visible one or the viewer sees black.
    expect(b.style.opacity).toBe("1");
    expect(a.style.opacity).toBe("0");
    expect(a.src).toBe(clip("c3").videoUrl);

    // The deferred outgoing-slot cleanup must not clobber that preload.
    vi.advanceTimersByTime(500);
    expect(a.src).toBe(clip("c3").videoUrl);

    // c2 ends: c3 plays from a instead of the stream dying.
    b.fireTimeUpdate(9.95);
    await flush();
    expect(a.paused).toBe(false);
    expect(player.getActiveSlot()).toBe("a");
    expect(player.getStatus()).toBe("playing");
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
    expect(player.getActiveSlot()).toBe("b");
    expect(b.loop).toBe(false);
  });

  it("cuts a requested clip into a looping idle as soon as it is playable, returning the displaced idle", async () => {
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

    // The reply lands: it replaces the preloaded idle and takes the screen without waiting.
    queue.unshift(clip("reply", false, true));
    player.checkForClip();
    await flush();
    expect(returned).toEqual(["idle2"]);
    expect(b.src).toBe(clip("reply").videoUrl);
    expect(player.getActiveSlot()).toBe("b");
    expect(b.paused).toBe(false);
    expect(b.style.opacity).toBe("1");
    expect(a.style.opacity).toBe("0");
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

    a.fireTimeUpdate(9.6);
    await flush();
    expect(getFallbackClip).toHaveBeenCalledTimes(1);
    expect(b.src).toBe(clip("oldIdle").videoUrl);
    a.fireTimeUpdate(9.7);
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
    const { b, player } = setup(queue);
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

    b.fire("loadeddata"); // preload's readiness resolves; performSwap awaits incoming.play()
    await flush();
    expect(player.getActiveSlot()).toBe("a"); // play() has no decoded frame yet
    expect(started).toEqual([]);

    b.fire("playing"); // confirms a decoded frame; swap completes exactly once
    await flush();

    expect(player.getActiveSlot()).toBe("b");
    expect(started).toEqual(["incoming"]);
    expect(b.style.opacity).toBe("1");
    expect(b.paused).toBe(false);
  });

  it("ignores a stale canplaythrough from an earlier, superseded preload", async () => {
    const queue: ClipToPlay[] = [clip("loop1", true)];
    const { b, player } = setup(queue);
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
    b.fire("playing"); // confirmPlaying for the (correct) in-flight swap
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
    expect(player.getActiveSlot()).toBe("a");

    b.fire("playing"); // ignored: rVFC is preferred once available, this alone must not swap
    await flush();
    expect(player.getActiveSlot()).toBe("a");
    expect(started).toEqual([]);

    b.fireVideoFrame(); // a real presented frame confirms the swap
    await flush();
    expect(player.getActiveSlot()).toBe("b");
    expect(started).toEqual(["incoming"]);
  });
});
