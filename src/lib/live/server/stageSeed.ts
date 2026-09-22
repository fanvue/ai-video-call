import { LIVE_TUNABLES, type SceneId } from "@/lib/live/contract";
import {
  pollSceneStillUntilComplete,
  submitSceneStill,
} from "@/lib/fal/requestSceneStill";

// Seedream v4 edit list price per image.
export const STAGE_SEED_COST_USD = 0.03;

// Same aspect as the 542x988 clips so the greeting's first frame is the still, not a crop of it.
const STILL_SIZE = { width: 1024, height: 1820 };

export type StagedSeed = { url: string; costUsd: number };

// Room descriptions for the still only. SURROUNDINGS_BY_SCENE (used by the clip prompts) mentions laptops and webcams, and any "webcam" or "laptop camera" wording made the editors draw her on a laptop screen instead of in the room.
const STAGE_ROOM_BY_SCENE: Record<SceneId, string> = {
  bedroom:
    "She sits on the edge of her bed in a cosy bedroom, a made bed and a plain wall behind her, soft warm lamp light.",
  office:
    "She sits at her desk in a small home office, a bookshelf behind her, daylight through a blind.",
  livingRoom:
    "She sits in the corner of a living room couch, a lamp and a plant behind her, warm evening light.",
  kitchen:
    "She sits at a kitchen counter, a tidy kitchen behind her, bright morning light.",
};

const buildStagePrompt = (sceneId: SceneId, lookLock: string): string =>
  [
    `Candid photo of the same woman as in the reference image, identical face, hair, skin tone and build (${lookLock}).`,
    STAGE_ROOM_BY_SCENE[sceneId],
    "She faces the viewer at eye level, medium shot from the waist up, relaxed natural smile, hands resting in her lap.",
    "She wears a plain white bra and matching plain white panties.",
    "Photorealistic, natural skin texture, slight soft focus.",
  ].join(" ");

// Best-effort: a refusal, failure or timeout means the greeting starts on the raw upload as before. Rejections are logged, never retried or reworded.
export const stageSeed = async ({
  referenceUrl,
  sceneId,
  lookLock,
}: {
  referenceUrl: string;
  sceneId: SceneId;
  lookLock: string;
}): Promise<StagedSeed | null> => {
  const started = Date.now();
  try {
    const submitted = await submitSceneStill({
      prompt: buildStagePrompt(sceneId, lookLock),
      image_urls: [referenceUrl],
      num_images: 1,
      image_size: STILL_SIZE,
    });
    const result = await pollSceneStillUntilComplete({
      statusUrl: submitted.status_url,
      responseUrl: submitted.response_url,
      timeoutMs: LIVE_TUNABLES.STAGE_SEED_BUDGET_MS,
    });
    const url = result.images[0]?.url;
    if (!url) {
      return null;
    }
    console.log(
      `stageSeed: staged scene=${sceneId} ms=${Date.now() - started}`,
    );
    return { url, costUsd: STAGE_SEED_COST_USD };
  } catch (error) {
    console.warn(
      `stageSeed: staging failed after ${Date.now() - started}ms, greeting starts on the upload`,
      error,
    );
    return null;
  }
};
