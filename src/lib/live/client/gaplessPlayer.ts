// Two-<video> gapless controller: pulls the next clip from the pipeline via getNextClip.
import type { SpeechMode } from "@/lib/live/contract";

const SWAP_LEAD_SEC = 0.12;
const CROSSFADE_MS = 180;
// Ported from the legacy call page: the model's rendered audio pops for ~1.1s at clip start, so
// native-speech playback stays silent through that window then ramps volume up over 280ms.
const AUDIO_POP_HIDE_MS = 1100;
const AUDIO_RAMP_MS = 280;
// How long a preloading element gets before its readiness is treated as a failure, not a stall.
const LOAD_TIMEOUT_MS = 8000;
// How long play() gets to actually produce a decoded frame before the swap is aborted.
const PLAY_CONFIRM_TIMEOUT_MS = 4000;
const HAVE_CURRENT_DATA = 2;

export type PlayerStatus = "empty" | "playing" | "holding" | "needsTap";

export type ClipToPlay = {
  id: string;
  videoUrl: string;
  durationSec: number;
  hasSpeech: boolean;
  // Starts and ends on the same frame: the element loops it natively while the next clip renders.
  loops: boolean;
  // A requested clip (reply / beat / settle): cuts into a looping idle the moment it is playable
  // instead of waiting for the loop and any preloaded idle to run out.
  interrupts: boolean;
};

// A paused active element that should be playing gets one play() nudge per this window.
const RESUME_NUDGE_MS = 2000;

export type GaplessPlayerOptions = {
  onStatusChange: (status: PlayerStatus) => void;
};

const noopProgress = (): void => {};
const noopClipStarted = (): void => {};
const noopGetNextClip = (): null => null;
const noopHasInterruptReady = (): boolean => false;
const noopClipReturned = (): void => {};

// timeupdate fires only ~4Hz, which alone leaves a visible gap before the swap point.
// Resolves false on timeout: a readiness timeout is a failure, not a fallback success.
const waitForPlayable = (el: HTMLVideoElement): Promise<boolean> =>
  new Promise((resolve) => {
    if (el.readyState >= HAVE_CURRENT_DATA) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      el.removeEventListener("loadeddata", done);
      el.removeEventListener("canplaythrough", done);
      resolve(false);
    }, LOAD_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener("loadeddata", done);
      el.removeEventListener("canplaythrough", done);
      resolve(true);
    };
    el.addEventListener("loadeddata", done, { once: true });
    el.addEventListener("canplaythrough", done, { once: true });
  });

// A video element exposing requestVideoFrameCallback — not in lib.dom.d.ts yet, so declared locally.
type RvfcVideoElement = HTMLVideoElement & {
  requestVideoFrameCallback: (callback: () => void) => number;
  cancelVideoFrameCallback: (handle: number) => void;
};

// Confirms play() actually produced a decoded frame (browsers can resolve play() early). Prefers rVFC, which fires only once a frame is presented; a hidden tab presents no frames, so `playing` stands in there.
const confirmPlaying = (el: HTMLVideoElement): Promise<boolean> =>
  new Promise((resolve) => {
    if (el.readyState >= HAVE_CURRENT_DATA) {
      resolve(true);
      return;
    }
    const rvfcEl = el as Partial<RvfcVideoElement>;
    const hasRvfc = typeof rvfcEl.requestVideoFrameCallback === "function";
    let frameHandle: number | null = null;
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      el.removeEventListener("playing", onEvent);
      el.removeEventListener("loadeddata", onEvent);
      if (frameHandle !== null) {
        rvfcEl.cancelVideoFrameCallback?.(frameHandle);
      }
      resolve(ok);
    };
    const onEvent = () => {
      const hidden = typeof document !== "undefined" && document.hidden;
      if (!hasRvfc || hidden) {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), PLAY_CONFIRM_TIMEOUT_MS);
    if (typeof rvfcEl.requestVideoFrameCallback === "function") {
      frameHandle = rvfcEl.requestVideoFrameCallback(() => finish(true));
    }
    el.addEventListener("playing", onEvent);
    el.addEventListener("loadeddata", onEvent);
  });

export class GaplessPlayer {
  private a: HTMLVideoElement | null = null;
  private b: HTMLVideoElement | null = null;
  private activeSlot: "a" | "b" = "a";
  private preloadedClip: ClipToPlay | null = null;
  private preloadedSlot: "a" | "b" | null = null;
  private status: PlayerStatus = "empty";
  private disposed = false;
  private currentClipId: string | null = null;
  private currentClipLoops = false;
  private currentDurationSec = 0;
  private currentTimeSec = 0;
  private lastResumeNudgeMs = Number.NEGATIVE_INFINITY;
  private userMuted = false;
  private speechMode: SpeechMode = "text";
  private rafId: number | null = null;
  // Bumped on every new load into a slot; a stale async continuation whose generation no longer
  // matches was superseded by a later load and must not touch slot state.
  private swapGeneration = 0;
  private readonly failedOnce = new Set<string>();
  // Assigned post-render via setters (never passed as constructor closures) so a ref-reading
  // callback is never invoked as part of building this instance during render.
  private onProgress: (currentTimeSec: number, clipId: string) => void =
    noopProgress;
  private onClipStarted: (clipId: string) => void = noopClipStarted;
  private getNextClip: () => ClipToPlay | null = noopGetNextClip;
  private hasInterruptReady: () => boolean = noopHasInterruptReady;
  // A preloaded idle displaced by a cut-in goes back to the pipeline rather than being lost.
  private onClipReturned: (clipId: string) => void = noopClipReturned;

  constructor(private readonly options: GaplessPlayerOptions) {}

  setInterruptReadyHandler(handler: () => boolean): void {
    this.hasInterruptReady = handler;
  }

  setClipReturnedHandler(handler: (clipId: string) => void): void {
    this.onClipReturned = handler;
  }

  setSpeechMode(mode: SpeechMode): void {
    this.speechMode = mode;
  }

  setProgressHandler(
    handler: (currentTimeSec: number, clipId: string) => void,
  ): void {
    this.onProgress = handler;
  }

  setClipStartedHandler(handler: (clipId: string) => void): void {
    this.onClipStarted = handler;
  }

  setNextClipHandler(handler: () => ClipToPlay | null): void {
    this.getNextClip = handler;
  }

  attach(a: HTMLVideoElement, b: HTMLVideoElement): void {
    this.a = a;
    this.b = b;
    this.showSlot(this.activeSlot);
    a.addEventListener("timeupdate", this.onTimeUpdate);
    b.addEventListener("timeupdate", this.onTimeUpdate);
    this.startRafLoop();
  }

  dispose(): void {
    this.disposed = true;
    this.stopRafLoop();
    this.a?.removeEventListener("timeupdate", this.onTimeUpdate);
    this.b?.removeEventListener("timeupdate", this.onTimeUpdate);
  }

  private getActive(): HTMLVideoElement | null {
    return this.activeSlot === "a" ? this.a : this.b;
  }

  private getInactive(): HTMLVideoElement | null {
    return this.activeSlot === "a" ? this.b : this.a;
  }

  // The player owns slot visibility: React never re-renders on a swap, so it is done on the DOM.
  private showSlot(slot: "a" | "b"): void {
    if (this.a) {
      this.a.style.opacity = slot === "a" ? "1" : "0";
    }
    if (this.b) {
      this.b.style.opacity = slot === "b" ? "1" : "0";
    }
  }

  private setStatus(status: PlayerStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.options.onStatusChange(status);
  }

  // Begins playback once attached; call checkForClip() to retry if nothing was ready yet.
  start(): void {
    if (this.status !== "empty") {
      return;
    }
    const clip = this.getNextClip();
    if (!clip) {
      return;
    }
    void this.playNow(clip);
  }

  // Nudge from the pipeline that a new clip may be available: fill a hold, or the initial slot.
  checkForClip(): void {
    if (this.disposed) {
      return;
    }
    if (this.status === "empty") {
      this.start();
      return;
    }
    if (this.maybeCutIn()) {
      return;
    }
    if (!this.preloadedClip) {
      this.preloadNextIfNeeded();
    }
  }

  // While an idle loops, a freshly rendered requested clip takes the screen as soon as it can play.
  private maybeCutIn(): boolean {
    if (
      this.status !== "playing" ||
      !this.currentClipLoops ||
      !this.hasInterruptReady() ||
      this.preloadedClip?.interrupts
    ) {
      return false;
    }
    const displaced = this.preloadedClip;
    const clip = this.getNextClip();
    if (!clip || !clip.interrupts) {
      return false;
    }
    if (displaced) {
      this.preloadedClip = null;
      this.preloadedSlot = null;
      this.onClipReturned(displaced.id);
    }
    void this.preload(clip);
    return true;
  }

  private preloadNextIfNeeded(): void {
    if (this.disposed || this.preloadedClip) {
      return;
    }
    const clip = this.getNextClip();
    if (!clip) {
      return;
    }
    void this.preload(clip);
  }

  private async preload(clip: ClipToPlay): Promise<void> {
    const inactive = this.getInactive();
    if (!inactive) {
      return;
    }
    const targetSlot = this.activeSlot === "a" ? "b" : "a";
    this.preloadedClip = clip;
    const generation = ++this.swapGeneration;
    inactive.src = clip.videoUrl;
    inactive.loop = clip.loops;
    inactive.muted = true;
    inactive.load();
    const playable = await waitForPlayable(inactive);
    if (
      this.disposed ||
      this.preloadedClip !== clip ||
      generation !== this.swapGeneration
    ) {
      // Superseded by a later preload, or disposed mid-wait: ignore this obsolete callback.
      return;
    }
    if (!playable) {
      // Readiness timeout is a failure, not a fallback success: drop this attempt and let the
      // pipeline see it come back so it can requeue or discard it.
      this.failClip(clip);
      return;
    }
    this.preloadedSlot = targetSlot;
    if (
      this.status === "holding" ||
      (clip.interrupts && this.currentClipLoops)
    ) {
      void this.performSwap(clip);
    }
  }

  // A clip that never became playable, or whose play() never produced a frame: tell the pipeline
  // and go look for something else rather than leaving the player stuck on nothing.
  // A clip gets one more chance after a readiness failure; a second failure drops it, otherwise a
  // broken URL would be requeued at the front and retried forever, one load timeout per cycle.
  private failClip(clip: ClipToPlay): void {
    if (this.preloadedClip === clip) {
      this.preloadedClip = null;
      this.preloadedSlot = null;
    }
    if (this.failedOnce.has(clip.id)) {
      this.failedOnce.delete(clip.id);
    } else {
      this.failedOnce.add(clip.id);
      this.onClipReturned(clip.id);
    }
    this.preloadNextIfNeeded();
  }

  private async playNow(clip: ClipToPlay): Promise<void> {
    const el = this.getActive();
    if (!el) {
      return;
    }
    const generation = ++this.swapGeneration;
    el.src = clip.videoUrl;
    el.loop = clip.loops;
    el.load();
    const playable = await waitForPlayable(el);
    if (this.disposed || generation !== this.swapGeneration) {
      return;
    }
    if (!playable) {
      // Nothing was ever shown, so there's no outgoing element to protect: just ask for another.
      this.onClipReturned(clip.id);
      this.start();
      return;
    }
    this.currentClipId = clip.id;
    this.currentClipLoops = clip.loops;
    this.currentDurationSec = clip.durationSec;
    this.currentTimeSec = 0;
    this.applyAudioPolicy(el, clip);
    this.showSlot(this.activeSlot);
    try {
      await el.play();
    } catch {
      this.setStatus("needsTap");
      return;
    }
    const confirmed = await confirmPlaying(el);
    if (this.disposed || generation !== this.swapGeneration) {
      return;
    }
    if (!confirmed) {
      this.onClipReturned(clip.id);
      this.start();
      return;
    }
    this.setStatus("playing");
    this.onClipStarted(clip.id);
    this.preloadNextIfNeeded();
  }

  // User-gesture retry after autoplay was blocked.
  resumeAfterTap(): void {
    const el = this.getActive();
    const clipId = this.currentClipId;
    if (!el || !clipId) {
      return;
    }
    el.muted = false;
    void el.play().then(() => {
      this.setStatus("playing");
      this.onClipStarted(clipId);
      this.preloadNextIfNeeded();
    });
  }

  // Manual mute overrides the speechMode policy in either direction; unmuting lets the policy
  // (silent text-mode idle vs. ramped native speech) take back over for the next applied clip.
  setMuted(muted: boolean): void {
    this.userMuted = muted;
    const active = this.getActive();
    if (active && muted) {
      active.muted = true;
    }
  }

  private applyAudioPolicy(el: HTMLVideoElement, clip: ClipToPlay): void {
    if (this.userMuted) {
      el.muted = true;
      return;
    }
    if (this.speechMode === "text" && !clip.hasSpeech) {
      el.muted = true;
      el.volume = 1;
      return;
    }
    el.muted = false;
    el.volume = 0;
    const start = performance.now();
    const ramp = () => {
      if (this.disposed || this.getActive() !== el) {
        return;
      }
      const elapsed = performance.now() - start;
      const level =
        elapsed < AUDIO_POP_HIDE_MS
          ? 0
          : Math.min(1, (elapsed - AUDIO_POP_HIDE_MS) / AUDIO_RAMP_MS);
      el.volume = level;
      if (level < 1) {
        requestAnimationFrame(ramp);
      }
    };
    requestAnimationFrame(ramp);
  }

  // Swaps only once incoming.play() has resolved and produced a decoded frame; until then the
  // outgoing element owns visibility, so a stalled/black incoming slot never replaces a live one.
  private async performSwap(clip: ClipToPlay): Promise<void> {
    const outgoing = this.getActive();
    const incoming = this.getInactive();
    if (!incoming) {
      return;
    }
    // Not bumped here: this swap belongs to the load that already completed in preload(); a
    // later preload superseding it will bump this and invalidate the check below.
    const generation = this.swapGeneration;
    this.applyAudioPolicy(incoming, clip);
    let confirmed: boolean;
    try {
      await incoming.play();
      confirmed = await confirmPlaying(incoming);
    } catch {
      confirmed = false;
    }
    if (this.disposed || generation !== this.swapGeneration) {
      // A newer preload superseded this attempt; that one owns the outcome now.
      return;
    }
    if (!confirmed) {
      this.failClip(clip);
      // A non-looping outgoing element that already reached its end falls into the existing hold
      // behavior; a looping one just keeps looping untouched.
      if (outgoing && !outgoing.loop) {
        outgoing.pause();
        this.setStatus("holding");
      }
      return;
    }
    this.currentClipId = clip.id;
    this.currentClipLoops = clip.loops;
    this.currentDurationSec = clip.durationSec;
    this.currentTimeSec = 0;
    this.activeSlot = this.activeSlot === "a" ? "b" : "a";
    this.showSlot(this.activeSlot);
    this.preloadedSlot = null;
    this.preloadedClip = null;
    this.setStatus("playing");
    this.onClipStarted(clip.id);
    this.preloadNextIfNeeded();
    window.setTimeout(() => {
      if (!outgoing) {
        return;
      }
      // preloadNextIfNeeded above usually re-targets this element with the next clip's src;
      // clearing it here would wipe that preload and leave the following swap with nothing.
      if (this.preloadedClip && this.getInactive() === outgoing) {
        return;
      }
      outgoing.pause();
      outgoing.removeAttribute("src");
      outgoing.load();
    }, CROSSFADE_MS);
  }

  private checkSwapBoundary(el: HTMLVideoElement): void {
    if (el !== this.getActive() || !el.duration || Number.isNaN(el.duration)) {
      return;
    }
    this.currentDurationSec = el.duration;
    this.currentTimeSec = el.currentTime;
    this.onProgress(el.currentTime, this.currentClipId ?? "");
    const nearEnd = el.currentTime >= el.duration - SWAP_LEAD_SEC;
    if (!nearEnd) {
      return;
    }
    if (this.preloadedClip && this.preloadedSlot) {
      void this.performSwap(this.preloadedClip);
      return;
    }
    // A clip is still loading: hold for it rather than pulling (and losing) another from the buffer.
    if (!this.preloadedClip) {
      // Nothing preloaded yet: give it one last chance in case a clip landed since we last checked.
      const clip = this.getNextClip();
      if (clip) {
        void this.preload(clip);
        return;
      }
    }
    // A looping clip keeps playing seamlessly; only a one-shot clip has to hold on its last frame.
    if (el.loop) {
      return;
    }
    if (this.status !== "holding") {
      el.pause();
      this.setStatus("holding");
    }
  }

  private readonly onTimeUpdate = (event: Event): void => {
    this.checkSwapBoundary(event.currentTarget as HTMLVideoElement);
  };

  // rAF runs well ahead of the ~4Hz timeupdate tick, catching the swap point sooner.
  private startRafLoop(): void {
    if (this.rafId !== null) {
      return;
    }
    const step = () => {
      if (this.disposed) {
        return;
      }
      const active = this.getActive();
      if (active && this.status === "playing") {
        this.checkSwapBoundary(active);
        this.nudgeIfStalled(active);
      }
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  // Seen in prod: the greeting sat loaded but paused at frame 0 for a minute with status "playing".
  // Whatever paused it (tab occlusion, a stray pause), the stream must not wait for a tap.
  private nudgeIfStalled(active: HTMLVideoElement): void {
    if (!active.paused || active.ended || active.readyState < 2) {
      return;
    }
    const now = performance.now();
    if (now - this.lastResumeNudgeMs < RESUME_NUDGE_MS) {
      return;
    }
    this.lastResumeNudgeMs = now;
    void active.play().catch(() => this.setStatus("needsTap"));
  }

  private stopRafLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  // Sum of what's already buffered: the current clip's remaining time plus a preloaded one.
  getBufferedSec(): number {
    const remaining = Math.max(
      0,
      this.currentDurationSec - this.currentTimeSec,
    );
    return remaining + (this.preloadedClip?.durationSec ?? 0);
  }

  // Reused across sessions in the same component instance: clears playback state without
  // touching the DOM elements or listeners attach() already wired up.
  reset(): void {
    this.a?.pause();
    this.b?.pause();
    this.preloadedClip = null;
    this.preloadedSlot = null;
    this.status = "empty";
    this.currentClipId = null;
    this.currentClipLoops = false;
    this.currentDurationSec = 0;
    this.currentTimeSec = 0;
    this.activeSlot = "a";
    this.showSlot("a");
    this.userMuted = false;
    // Invalidate any in-flight preload/swap continuation from the previous session.
    this.swapGeneration += 1;
  }

  getActiveSlot(): "a" | "b" {
    return this.activeSlot;
  }

  getStatus(): PlayerStatus {
    return this.status;
  }
}
