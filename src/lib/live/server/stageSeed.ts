import { LIVE_TUNABLES, type SceneId } from "@/lib/live/contract";
import type { Persona } from "@/lib/live/persona";
import {
  pollSceneStillUntilComplete,
  submitSceneStill,
} from "@/lib/fal/requestSceneStill";
import { stageRoomFor } from "./sceneRooms";

// Seedream v4 edit list price per image.
export const STAGE_SEED_COST_USD = 0.03;

// Same aspect as the 542x988 clips so the greeting's first frame is the still, not a crop of it.
const STILL_SIZE = { width: 1024, height: 1820 };

export type StagedSeed = { url: string; costUsd: number };

const buildStagePrompt = (
  sceneId: SceneId,
  lookLock: string,
  p: Persona,
): string =>
  [
    `Candid photo of the same ${p.noun} as in the reference image, identical face, hair, skin tone and build (${lookLock}).`,
    stageRoomFor(sceneId, p),
    `${p.Subject} faces the viewer at eye level, medium shot from the waist up, relaxed natural smile, hands resting in ${p.possessive} lap.`,
    // Matches the reference route's canon wardrobe for each gender.
    p.gender === "male"
      ? "He wears a plain white crew-neck t-shirt and plain grey boxer briefs."
      : "She wears a plain white bra and matching plain white panties.",
    "Photorealistic, natural skin texture, slight soft focus.",
  ].join(" ");

// Best-effort: a refusal, failure or timeout means the greeting starts on the raw upload as before. Rejections are logged, never retried or reworded.
export const stageSeed = async ({
  referenceUrl,
  sceneId,
  lookLock,
  persona,
}: {
  referenceUrl: string;
  sceneId: SceneId;
  lookLock: string;
  persona: Persona;
}): Promise<StagedSeed | null> => {
  const started = Date.now();
  try {
    const submitted = await submitSceneStill({
      prompt: buildStagePrompt(sceneId, lookLock, persona),
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
