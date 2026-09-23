// When her typed reply lands in chat: on the clip that carries the request's action, not on a pose or greeting step ahead of it.

// The typing bubble shows from clipReady, so a held reply still reads as ~3 s of typing.
export const HELD_REPLY_TYPING_FLOOR_MS = 3_000;
// If the action clip never plays (failed render, dropped chain), the text still lands.
export const HELD_REPLY_MAX_WAIT_MS = 30_000;

export type PendingReveal = {
  clipId: string;
  requestId: string | null;
  text: string;
  channel: "chat" | "voice";
  typingLeadSec: number;
  // The reply clip is setupOnly: the text waits for the request's next clip that is not.
  holdForAction: boolean;
  // Set once the held reply clip has been on screen, so only a clip after it can release the text.
  replySeen: boolean;
  readyAtMs: number;
};

export type PlayingClip = {
  clipId: string;
  currentTimeSec: number;
  requestId: string | null;
  setupOnly: boolean;
  idle: boolean;
};

// Mutates pending.replySeen; returns whether the text is due now.
export const replyRevealDue = (
  pending: PendingReveal,
  playing: PlayingClip,
  nowMs: number,
): boolean => {
  if (playing.clipId === pending.clipId) {
    if (!pending.holdForAction) {
      return playing.currentTimeSec >= pending.typingLeadSec;
    }
    pending.replySeen = true;
    return false;
  }
  if (!pending.holdForAction || !pending.replySeen) {
    return false;
  }
  if (nowMs < pending.readyAtMs + HELD_REPLY_TYPING_FLOOR_MS) {
    return false;
  }
  if (nowMs >= pending.readyAtMs + HELD_REPLY_MAX_WAIT_MS) {
    return true;
  }
  // Idle filler while the action clip swaps, or another setup step of this request, keeps holding.
  if (playing.idle) {
    return false;
  }
  return !(playing.requestId === pending.requestId && playing.setupOnly);
};
