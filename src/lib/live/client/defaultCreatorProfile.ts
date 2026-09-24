// Data, not code: the default tip menu and creator shell shown before a reference photo exists.
import type {
  CreatorGender,
  CreatorProfile,
  SceneId,
  TipMenuItem,
} from "@/lib/live/contract";

// Superset of TipMenuItem for the tip menu UI (emoji + 18+ badge); the extra fields are dropped
// wherever only a TipMenuItem is expected (e.g. CreatorProfile.tipMenu).
export type TipMenuAction = TipMenuItem & { emoji: string; explicit: boolean };

export const DEFAULT_TIP_MENU: TipMenuAction[] = [
  {
    id: "wave",
    label: "Wave hi",
    request: "wave at me",
    priceCents: 20,
    emoji: "👋",
    explicit: false,
  },
  {
    id: "spin",
    label: "Spin around",
    request: "spin around for me",
    priceCents: 30,
    emoji: "🔄",
    explicit: false,
  },
  {
    id: "chair-lean-back",
    label: "Chair Lean Back",
    request: "lean back in your chair",
    priceCents: 50,
    emoji: "😮‍💨",
    explicit: false,
  },
  {
    id: "tee-lift",
    label: "Tee Lift",
    request: "lift your top",
    priceCents: 80,
    emoji: "👕",
    explicit: false,
  },
  {
    id: "dance",
    label: "Dance",
    request: "dance for me",
    priceCents: 100,
    emoji: "💃",
    explicit: false,
  },
  {
    id: "strap-tease",
    label: "Strap Tease",
    request: "tease with your bra strap",
    priceCents: 120,
    emoji: "👙",
    explicit: false,
  },
  {
    id: "bend-over",
    label: "Bend over",
    request: "bend over and show me",
    priceCents: 200,
    emoji: "🍑",
    explicit: true,
  },
  {
    id: "topless-play",
    label: "Topless Play",
    request: "take your top and bra off",
    priceCents: 250,
    emoji: "🍒",
    explicit: true,
  },
  {
    id: "blowjob-toy",
    label: "Blowjob (Toy)",
    request: "suck the toy",
    priceCents: 400,
    emoji: "💋",
    explicit: true,
  },
  {
    id: "vibrator-play",
    label: "Vibrator Play",
    request: "use your vibrator",
    priceCents: 500,
    emoji: "〰️",
    explicit: true,
  },
];

export const defaultCreatorProfile = (
  displayName: string,
  sceneId: SceneId,
  lookLock: string,
  gender: CreatorGender = "female",
): CreatorProfile => ({
  id: "spike-creator",
  displayName: displayName || (gender === "male" ? "Him" : "Her"),
  gender,
  lookLock,
  sceneId,
  tipMenu: DEFAULT_TIP_MENU.map(({ id, label, request, priceCents }) => ({
    id,
    label,
    request,
    priceCents,
  })),
});
