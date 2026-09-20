// Simulated cam-room population (roster, ambient chatter, viewer requests); pure + injectable RNG so it's deterministic in tests. See docs/LIVE_ENGINE.md.

import type { ClipResult, LiveState, TipMenuItem } from "@/lib/live/contract";

export type RandomSource = () => number; // uniform [0, 1)

// Small deterministic PRNG (mulberry32) so a fixed seed reproduces an identical room across a run.
export const createSeededRandom = (seed: number): RandomSource => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Generic, never-real handles. Pool is larger than MAX_ROSTER so roster turnover doesn't repeat
// the same faces every join.
const HANDLE_POOL = [
  "nightowl_92",
  "kdub",
  "luca_m",
  "quiet_storm",
  "benji.codes",
  "mxpaul",
  "riverside22",
  "tazzy",
  "greyskies",
  "juniper_",
  "olliehere",
  "vex_r",
  "sammich99",
  "dee_dubs",
  "northline",
  "pxlwave",
  "corvid.k",
  "sunny_daze",
  "wrenfeather",
  "milo_b",
  "static_hum",
  "tobyknows",
  "hazel.exe",
  "pinegrove",
  "kestrel7",
  "wavelength_",
  "arlo_j",
  "bramblebee",
  "coyote_moon",
  "finch_and_co",
] as const;

export const MIN_ROSTER = 8;
export const MAX_ROSTER = 20;
export const MAX_ROSTER_JUMP = 3;

// Free-text requests a viewer might type themselves (vs. a priced tip-menu pick); go through the same reply path as a fan's own message.
const GENERIC_VIEWER_REQUESTS = [
  "wave at me",
  "blow a kiss",
  "smile for the camera",
  "say hi to chat",
  "can you turn around",
  "what are you drinking",
] as const;

export type RoomChatMessage = {
  id: string;
  // "note" is a system line the caller builds itself (e.g. "she's getting to @handle's request").
  kind: "chatter" | "join" | "leave" | "tip" | "note";
  text: string;
  // Present for chatter/tip; absent for a collapsed join/leave summary (handles listed separately).
  handle?: string;
  handles?: string[];
  tipCents?: number;
  atMs: number;
};

export type ViewerRequest = {
  handle: string;
  text: string;
  tipCents?: number;
};

export type RoomSimTickContext = {
  nowMs: number;
  liveState: LiveState | null;
  // True only when the director's queue and the pipeline's chain lane are both idle.
  systemIdle: boolean;
  tipMenu: readonly TipMenuItem[];
};

export type RoomSimTickResult = {
  viewerCount: number;
  joined: string[];
  left: string[];
  chatMessages: RoomChatMessage[];
  viewerRequest: ViewerRequest | null;
};

export type RoomSimOptions = {
  rng: RandomSource;
  initialViewerCount?: number;
  // Ambient chatter interval while idle vs. just after a clip lands (a "burst"), in ms.
  idleChatterIntervalMsRange?: [number, number];
  burstChatterIntervalMsRange?: [number, number];
  burstWindowMs?: number;
  rosterDriftIntervalMsRange?: [number, number];
  // How often (ms) an eligible viewer request may fire. Spec: roughly 60-120s, tunable for tests.
  viewerRequestIntervalMsRange?: [number, number];
  // Off by default: viewers only compliment, and only the fan on this device can change her state.
  allowViewerRequests?: boolean;
};

const pick = <T>(rng: RandomSource, items: readonly T[]): T => {
  const value = items[Math.floor(rng() * items.length)];
  // items is always non-empty at call sites; guard keeps this total for the type checker.
  if (value === undefined) {
    throw new Error("roomSim: pick() called on an empty list");
  }
  return value;
};

const randomBetween = (
  rng: RandomSource,
  [min, max]: [number, number],
): number => min + rng() * (max - min);

const GREETING_LINES = [
  "heyyy",
  "hii",
  "hello everyone",
  "sup",
  "yo 👋",
] as const;
const IDLE_LINES = [
  "😍",
  "cutie",
  "lol",
  "vibes",
  "brb",
  "just watching",
] as const;
const OFF_GARMENT_REACTIONS = [
  "🔥🔥🔥",
  "omg",
  "yesss",
  "there we go",
] as const;
const TIP_HYPE_LINES = [
  "big spender fr",
  "letsgooo",
  "gng",
  "she deserved that",
] as const;

// Off-garment reactions name the exact garment description from LiveState, never an invented one.
const offGarmentDescriptions = (state: LiveState): string[] =>
  (["top", "bottom", "bra", "panties"] as const)
    .filter((garment) => !state.wardrobe[garment].on)
    .map((garment) => state.wardrobe[garment].description);

const propInPlay = (state: LiveState): string | null =>
  state.body.prop !== "none" && state.body.prop !== "fetching"
    ? state.body.prop
    : null;

export class RoomSim {
  private readonly rng: RandomSource;
  private readonly idleChatterIntervalMsRange: [number, number];
  private readonly burstChatterIntervalMsRange: [number, number];
  private readonly burstWindowMs: number;
  private readonly rosterDriftIntervalMsRange: [number, number];
  private readonly viewerRequestIntervalMsRange: [number, number];
  private readonly allowViewerRequests: boolean;

  private viewers: string[] = [];
  private pool: string[];
  private idCounter = 0;
  private nextRosterDriftAtMs = 0;
  private nextChatterAtMs = 0;
  private burstUntilMs = 0;
  private nextViewerRequestAtMs = 0;
  private started = false;

  constructor(options: RoomSimOptions) {
    this.rng = options.rng;
    this.idleChatterIntervalMsRange = options.idleChatterIntervalMsRange ?? [
      8_000, 20_000,
    ];
    this.burstChatterIntervalMsRange = options.burstChatterIntervalMsRange ?? [
      1_500, 4_000,
    ];
    this.burstWindowMs = options.burstWindowMs ?? 12_000;
    this.rosterDriftIntervalMsRange = options.rosterDriftIntervalMsRange ?? [
      4_000, 12_000,
    ];
    this.viewerRequestIntervalMsRange =
      options.viewerRequestIntervalMsRange ?? [60_000, 120_000];
    this.allowViewerRequests = options.allowViewerRequests ?? false;
    this.pool = [...HANDLE_POOL];
    const initial = Math.max(
      MIN_ROSTER,
      Math.min(MAX_ROSTER, options.initialViewerCount ?? MIN_ROSTER + 2),
    );
    for (let i = 0; i < initial; i += 1) {
      const handle = this.draw();
      if (handle) {
        this.viewers.push(handle);
      }
    }
    this.nextRosterDriftAtMs = randomBetween(
      this.rng,
      this.rosterDriftIntervalMsRange,
    );
    this.nextChatterAtMs = randomBetween(
      this.rng,
      this.idleChatterIntervalMsRange,
    );
    this.nextViewerRequestAtMs = randomBetween(
      this.rng,
      this.viewerRequestIntervalMsRange,
    );
  }

  private nextId(): string {
    this.idCounter += 1;
    return `room-${this.idCounter}`;
  }

  // Draws a handle not currently in the room, cycling the pool back in once exhausted.
  private draw(): string | null {
    const available = this.pool.filter(
      (handle) => !this.viewers.includes(handle),
    );
    const source = available.length > 0 ? available : [...HANDLE_POOL];
    if (source.length === 0) {
      return null;
    }
    return pick(this.rng, source);
  }

  getViewerCount(): number {
    return this.viewers.length;
  }

  getViewers(): readonly string[] {
    return this.viewers;
  }

  // Grounded reaction burst when a clip lands; ambient chatter also runs hotter for burstWindowMs after.
  reactToClip(
    result: Pick<ClipResult, "jobKind" | "state">,
    nowMs: number,
    tipCents?: number,
  ): RoomChatMessage[] {
    this.burstUntilMs = nowMs + this.burstWindowMs;
    this.nextChatterAtMs = Math.min(
      this.nextChatterAtMs,
      nowMs + randomBetween(this.rng, this.burstChatterIntervalMsRange),
    );
    if (this.viewers.length === 0) {
      return [];
    }

    const lines: string[] = [];
    if (tipCents !== undefined) {
      lines.push(pick(this.rng, TIP_HYPE_LINES));
    }
    if (result.jobKind === "reply" || result.jobKind === "beat") {
      const offGarments = offGarmentDescriptions(result.state);
      if (offGarments.length > 0) {
        const garment = pick(this.rng, offGarments);
        lines.push(`${pick(this.rng, OFF_GARMENT_REACTIONS)} the ${garment}`);
      }
      const prop = propInPlay(result.state);
      if (prop) {
        lines.push(`that ${prop} 👀`);
      }
    }
    if (lines.length === 0) {
      return [];
    }

    const burstSize = Math.min(lines.length, 1 + Math.floor(this.rng() * 2));
    const messages: RoomChatMessage[] = [];
    for (let i = 0; i < burstSize; i += 1) {
      const handle = pick(this.rng, this.viewers);
      messages.push({
        id: this.nextId(),
        kind: "chatter",
        text: lines[i] ?? lines[0] ?? "",
        handle,
        atMs: nowMs + i * 400,
      });
    }
    return messages;
  }

  private tickRoster(nowMs: number): { joined: string[]; left: string[] } {
    if (nowMs < this.nextRosterDriftAtMs) {
      return { joined: [], left: [] };
    }
    this.nextRosterDriftAtMs =
      nowMs + randomBetween(this.rng, this.rosterDriftIntervalMsRange);

    const wantsToJoin = this.rng() < 0.55 || this.viewers.length <= MIN_ROSTER;
    const room =
      this.viewers.length <= MIN_ROSTER
        ? true
        : this.viewers.length >= MAX_ROSTER
          ? false
          : wantsToJoin;

    const changeCount = 1 + Math.floor(this.rng() * MAX_ROSTER_JUMP);
    const joined: string[] = [];
    const left: string[] = [];

    if (room) {
      const headroom = MAX_ROSTER - this.viewers.length;
      const count = Math.min(changeCount, headroom);
      for (let i = 0; i < count; i += 1) {
        const handle = this.draw();
        if (!handle) {
          break;
        }
        this.viewers.push(handle);
        joined.push(handle);
      }
    } else {
      const headroom = this.viewers.length - MIN_ROSTER;
      const count = Math.min(changeCount, headroom);
      for (let i = 0; i < count; i += 1) {
        const index = Math.floor(this.rng() * this.viewers.length);
        const [handle] = this.viewers.splice(index, 1);
        if (handle) {
          left.push(handle);
        }
      }
    }
    return { joined, left };
  }

  private tickChatter(ctx: RoomSimTickContext): RoomChatMessage[] {
    if (ctx.nowMs < this.nextChatterAtMs || this.viewers.length === 0) {
      return [];
    }
    const inBurst = ctx.nowMs < this.burstUntilMs;
    const range = inBurst
      ? this.burstChatterIntervalMsRange
      : this.idleChatterIntervalMsRange;
    this.nextChatterAtMs = ctx.nowMs + randomBetween(this.rng, range);

    const handle = pick(this.rng, this.viewers);
    const offGarments = ctx.liveState
      ? offGarmentDescriptions(ctx.liveState)
      : [];
    const pool = !this.started
      ? GREETING_LINES
      : offGarments.length > 0 && inBurst
        ? OFF_GARMENT_REACTIONS
        : IDLE_LINES;
    this.started = true;
    return [
      {
        id: this.nextId(),
        kind: "chatter",
        text: pick(this.rng, pool),
        handle,
        atMs: ctx.nowMs,
      },
    ];
  }

  private tickViewerRequest(ctx: RoomSimTickContext): ViewerRequest | null {
    if (!this.allowViewerRequests) {
      return null;
    }
    if (!ctx.systemIdle) {
      // Not eligible; push the window forward so a long busy stretch doesn't fire immediately
      // the instant the system frees up.
      this.nextViewerRequestAtMs = Math.max(
        this.nextViewerRequestAtMs,
        ctx.nowMs + randomBetween(this.rng, this.viewerRequestIntervalMsRange),
      );
      return null;
    }
    if (ctx.nowMs < this.nextViewerRequestAtMs || this.viewers.length === 0) {
      return null;
    }
    this.nextViewerRequestAtMs =
      ctx.nowMs + randomBetween(this.rng, this.viewerRequestIntervalMsRange);

    const handle = pick(this.rng, this.viewers);
    const wantsTip = ctx.tipMenu.length > 0 && this.rng() < 0.5;
    if (wantsTip) {
      const item = pick(this.rng, ctx.tipMenu);
      return { handle, text: item.request, tipCents: item.priceCents };
    }
    return { handle, text: pick(this.rng, GENERIC_VIEWER_REQUESTS) };
  }

  // Advance the room by one tick. Call roughly every second alongside the director's own tick.
  tick(ctx: RoomSimTickContext): RoomSimTickResult {
    const { joined, left } = this.tickRoster(ctx.nowMs);
    const chatMessages: RoomChatMessage[] = [];
    if (joined.length > 0) {
      chatMessages.push({
        id: this.nextId(),
        kind: "join",
        text: "",
        handles: joined,
        atMs: ctx.nowMs,
      });
    }
    if (left.length > 0) {
      chatMessages.push({
        id: this.nextId(),
        kind: "leave",
        text: "",
        handles: left,
        atMs: ctx.nowMs,
      });
    }
    chatMessages.push(...this.tickChatter(ctx));
    const viewerRequest = this.tickViewerRequest(ctx);

    return {
      viewerCount: this.viewers.length,
      joined,
      left,
      chatMessages,
      viewerRequest,
    };
  }

  // Tip event rendered directly (the request itself lands separately via LiveDirector.viewerRequest
  // -> the transcript already carries `paid`/`tipCents`); this is only for the room-chat highlight.
  tipMessage(handle: string, tipCents: number, nowMs: number): RoomChatMessage {
    return {
      id: this.nextId(),
      kind: "tip",
      text: pick(this.rng, TIP_HYPE_LINES),
      handle,
      tipCents,
      atMs: nowMs,
    };
  }
}
