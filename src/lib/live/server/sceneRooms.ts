import type { SceneId } from "@/lib/live/contract";

// Room descriptions for scene-setting generations (the staged still and the reference-to-video greeting). SURROUNDINGS_BY_SCENE (used by the clip prompts) mentions laptops and webcams, and any "webcam" or "laptop camera" wording made the editors draw her on a laptop screen instead of in the room.
export const STAGE_ROOM_BY_SCENE: Record<SceneId, string> = {
  bedroom:
    "She sits on the edge of her bed in a cosy bedroom, a made bed and a plain wall behind her, soft warm lamp light.",
  office:
    "She sits at her desk in a small home office, a bookshelf behind her, daylight through a blind.",
  livingRoom:
    "She sits in the corner of a living room couch, a lamp and a plant behind her, warm evening light.",
  kitchen:
    "She sits at a kitchen counter, a tidy kitchen behind her, bright morning light.",
};
