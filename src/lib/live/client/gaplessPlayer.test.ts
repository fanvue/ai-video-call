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
  muted = false;
  volume = 1;
  readyState = 2;
  duration = 10;
  currentTime = 0;
  paused = true;
  loadCalls = 0;
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
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  fireTimeUpdate(currentTime: number): void {
    this.currentTime = currentTime;
    for (const listener of this.listeners.get("timeupdate") ?? []) {
      listener({ currentTarget: this });
    }
  }
}

const clip = (id: string): ClipToPlay => ({
  id,
  videoUrl: `https://cdn.example/${id}.mp4`,
  durationSec: 10,
  hasSpeech: false,
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
});
