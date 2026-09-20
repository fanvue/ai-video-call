// Data, not code: the default tip menu and creator shell shown before a reference photo exists.
import type { CreatorProfile, SceneId } from "@/lib/live/contract";

export const DEFAULT_TIP_MENU = [
  { id: "wave", label: "Wave hi", request: "wave at me", priceCents: 100 },
  {
    id: "spin",
    label: "Spin around",
    request: "spin around for me",
    priceCents: 400,
  },
  { id: "dance", label: "Dance", request: "dance for me", priceCents: 500 },
  {
    id: "top-off",
    label: "Top off",
    request: "take your top off",
    priceCents: 800,
  },
  {
    id: "bend-over",
    label: "Bend over",
    request: "bend over and show me",
    priceCents: 1600,
  },
  {
    id: "toy",
    label: "Use a toy",
    request: "use a toy for me",
    priceCents: 5000,
  },
] as const;

export const defaultCreatorProfile = (
  displayName: string,
  sceneId: SceneId,
  lookLock: string,
): CreatorProfile => ({
  id: "spike-creator",
  displayName: displayName || "Her",
  lookLock,
  sceneId,
  tipMenu: DEFAULT_TIP_MENU.map((item) => ({ ...item })),
});
