// Two-<video> gapless controller: pulls the next clip from the pipeline via getNextClip.
import type { SpeechMode } from "@/lib/live/contract";

const SWAP_LEAD_SEC = 0.12;
const CROSSFADE_MS = 180;
// Ported from the legacy call page: the model's rendered audio pops for ~1.1s at clip start, so
// native-speech playback stays silent through that window then ramps volume up over 280ms.
const AUDIO_POP_HIDE_MS = 1100;
const AUDIO_RAMP_MS = 280;

export type PlayerStatus = "empty" | "playing" | "holding" | "needsTap";

export type ClipToPlay = {
  id: string;
  videoUrl: string;
  durationSec: number;
  hasSpeech: boolean;
};

export type GaplessPlayerOptions = {
  onStatusChange: (status: PlayerStatus) => void;
};

const noopProgress = (): void => {};
const noopClipStarted = (): void => {};
const noopGetNextClip = (): null => null;

// timeupdate fires only ~4Hz, which alone leaves a visible gap before the swap point.
const waitForPlayable = (el: HTMLVideoElement): Promise<void> =>
  new Promise((resolve) => {
    if (el.readyState >= 2) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 8000);
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener("loadeddata", done);
      el.removeEventListener("canplaythrough", done);
      resolve();
    };
    el.addEventListener("loadeddata", done, { once: true });
    el.addEventListener("canplaythrough", done, { once: true });
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
  private currentDurationSec = 0;
  private currentTimeSec = 0;
  private userMuted = false;
  private speechMode: SpeechMode = "text";
  private rafId: number | null = null;
  // Assigned post-render via setters (never passed as constructor closures) so a ref-reading
  // callback is never invoked as part of building this instance during render.
  private onProgress: (currentTimeSec: number, clipId: string) => void =
    noopProgress;
  private onClipStarted: (clipId: string) => void = noopClipStarted;
  private getNextClip: () => ClipToPlay | null = noopGetNextClip;

  constructor(private readonly options: GaplessPlayerOptions) {}

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
    if (!this.preloadedClip) {
      this.preloadNextIfNeeded();
    }
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
    inactive.src = clip.videoUrl;
    inactive.muted = true;
    inactive.load();
    await waitForPlayable(inactive);
    if (this.disposed || this.preloadedClip !== clip) {
      return;
    }
    this.preloadedSlot = targetSlot;
    if (this.status === "holding") {
      this.performSwap(clip);
    }
  }

  private async playNow(clip: ClipToPlay): Promise<void> {
    const el = this.getActive();
    if (!el) {
      return;
    }
    el.src = clip.videoUrl;
    el.load();
    await waitForPlayable(el);
    if (this.disposed) {
      return;
    }
    this.currentClipId = clip.id;
    this.currentDurationSec = clip.durationSec;
    this.currentTimeSec = 0;
    this.applyAudioPolicy(el, clip);
    try {
      await el.play();
      this.setStatus("playing");
      this.onClipStarted(clip.id);
      this.preloadNextIfNeeded();
    } catch {
      this.setStatus("needsTap");
    }
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

  private performSwap(clip: ClipToPlay): void {
    const outgoing = this.getActive();
    const incoming = this.getInactive();
    if (!incoming) {
      return;
    }
    this.currentClipId = clip.id;
    this.currentDurationSec = clip.durationSec;
    this.currentTimeSec = 0;
    this.applyAudioPolicy(incoming, clip);
    void incoming.play().catch(() => this.setStatus("needsTap"));
    this.activeSlot = this.activeSlot === "a" ? "b" : "a";
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
      this.performSwap(this.preloadedClip);
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
      }
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
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
    this.currentDurationSec = 0;
    this.currentTimeSec = 0;
    this.activeSlot = "a";
    this.userMuted = false;
  }

  getActiveSlot(): "a" | "b" {
    return this.activeSlot;
  }

  getStatus(): PlayerStatus {
    return this.status;
  }
}
