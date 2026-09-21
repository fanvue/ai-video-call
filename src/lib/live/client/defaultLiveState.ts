// body/world/surroundings have no server source (see docs/CONTRACT_CHANGES_CLIENT.md); client seeds defaults.
import type { LiveState, SceneId, Wardrobe } from "@/lib/live/contract";

const SURROUNDINGS_BY_SCENE: Record<SceneId, string> = {
  bedroom:
    "A tidy bedroom. Soft lamp light, a made bed in frame, a laptop webcam angle from a desk.",
  office:
    "A small home office. A desk, a bookshelf behind, daylight through a blind, webcam on a monitor.",
  livingRoom:
    "A living room couch corner, a lamp and a plant in frame, laptop propped on a coffee table.",
  kitchen:
    "A kitchen counter corner, morning light, a laptop propped against a fruit bowl.",
};

export const defaultLiveState = (
  sceneId: SceneId,
  wardrobe: Wardrobe,
  // Vision-captured real background from the reference photo; the preset is a fallback only, since
  // it otherwise contradicts what the first clip actually shows and the room visibly jumps on clip 2.
  capturedSurroundings?: string,
): LiveState => {
  const baseBody = {
    pose: "sitting" as const,
    facing: "camera" as const,
    hands: "free" as const,
    contact: "none" as const,
    prop: "none" as const,
    framing: "medium" as const,
  };
  return {
    wardrobe,
    body: baseBody,
    baselineBody: baseBody,
    world: "Settling in, webcam just turned on.",
    surroundings:
      capturedSurroundings?.trim() || SURROUNDINGS_BY_SCENE[sceneId],
  };
};
