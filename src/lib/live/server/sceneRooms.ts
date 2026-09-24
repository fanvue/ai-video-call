import type { SceneId } from "@/lib/live/contract";
import type { Persona } from "@/lib/live/persona";

// Room descriptions for scene-setting generations (the staged still and the reference-to-video greeting). SURROUNDINGS_BY_SCENE (used by the clip prompts) mentions laptops and webcams, and any "webcam" or "laptop camera" wording made the editors draw her on a laptop screen instead of in the room.
export const stageRoomFor = (sceneId: SceneId, p: Persona): string =>
  ({
    bedroom: `${p.Subject} sits on the edge of ${p.possessive} bed in a cosy bedroom, a made bed and a plain wall behind ${p.object}, soft warm lamp light.`,
    office: `${p.Subject} sits at ${p.possessive} desk in a small home office, a bookshelf behind ${p.object}, daylight through a blind.`,
    livingRoom: `${p.Subject} sits in the corner of a living room couch, a lamp and a plant behind ${p.object}, warm evening light.`,
    kitchen: `${p.Subject} sits at a kitchen counter, a tidy kitchen behind ${p.object}, bright morning light.`,
  })[sceneId];
