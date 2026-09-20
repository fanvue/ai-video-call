// Two-<video> gapless controller. Swaps on `timeupdate` near the end of the clip (not `ended`)
// so the decode/network gap for the next clip is hidden behind the still-playing tail.
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

const waitForLoadedData = (el: HTMLVideoElement): Promise<void> =>
  new Promise((resolve) => {
    if (el.readyState >= 2) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 8000);
    el.addEventListener(
      "loadeddata",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export class GaplessPlayer {
  private a: HTMLVideoElement | null = null;
  private b: HTMLVideoElement | null = null;
  private activeSlot: "a" | "b" = "a";
  private pending: ClipToPlay | null = null;
  private preloadedSlot: "a" | "b" | null = null;
  private status: PlayerStatus = "empty";
  private disposed = false;
  private currentClipId: string | null = null;
  private userMuted = false;
  private speechMode: SpeechMode = "text";
  // Assigned post-render via setters (never passed as constructor closures) so a ref-reading
  // callback is never invoked as part of building this instance during render.
  private onProgress: (currentTimeSec: number, clipId: string) => void =
    noopProgress;
  private onClipStarted: (clipId: string) => void = noopClipStarted;

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

  attach(a: HTMLVideoElement, b: HTMLVideoElement): void {
    this.a = a;
    this.b = b;
    a.addEventListener("timeupdate", this.onTimeUpdate);
    b.addEventListener("timeupdate", this.onTimeUpdate);
  }

  dispose(): void {
    this.disposed = true;
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

  // Called whenever the pipeline hands over a fresh clip. If nothing is playing yet, it starts
  // immediately; otherwise it preloads onto the inactive element and waits for the swap point.
  enqueue(clip: ClipToPlay): void {
    this.pending = clip;
    const active = this.getActive();
    if (!active || active.paused || active.ended || this.status === "empty") {
      void this.playNow(clip);
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
    inactive.src = clip.videoUrl;
    inactive.muted = true;
    inactive.load();
    await waitForLoadedData(inactive);
    if (this.disposed || this.pending !== clip) {
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
    await waitForLoadedData(el);
    if (this.disposed) {
      return;
    }
    this.currentClipId = clip.id;
    this.applyAudioPolicy(el, clip);
    try {
      await el.play();
      this.setStatus("playing");
      this.onClipStarted(clip.id);
      this.pending = null;
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
    this.applyAudioPolicy(incoming, clip);
    void incoming.play().catch(() => this.setStatus("needsTap"));
    this.activeSlot = this.activeSlot === "a" ? "b" : "a";
    this.preloadedSlot = null;
    this.pending = null;
    this.setStatus("playing");
    this.onClipStarted(clip.id);
    window.setTimeout(() => {
      outgoing?.pause();
    }, CROSSFADE_MS);
  }

  private readonly onTimeUpdate = (event: Event): void => {
    const el = event.currentTarget as HTMLVideoElement;
    if (el !== this.getActive() || !el.duration || Number.isNaN(el.duration)) {
      return;
    }
    this.onProgress(el.currentTime, this.currentClipId ?? "");
    const nearEnd = el.currentTime >= el.duration - SWAP_LEAD_SEC;
    if (!nearEnd) {
      return;
    }
    if (this.pending && this.preloadedSlot) {
      this.performSwap(this.pending);
      return;
    }
    if (this.status !== "holding") {
      el.pause();
      this.setStatus("holding");
    }
  };

  // Reused across sessions in the same component instance: clears playback state without
  // touching the DOM elements or listeners attach() already wired up.
  reset(): void {
    this.a?.pause();
    this.b?.pause();
    this.pending = null;
    this.preloadedSlot = null;
    this.status = "empty";
    this.currentClipId = null;
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
