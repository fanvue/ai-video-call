import {
  pollH3MaxReferenceVideoUntilComplete,
  submitH3MaxReferenceVideoGeneration,
} from "@/lib/fal/requestH3MaxReferenceVideo";
import {
  pollH3MaxVideoUntilComplete,
  submitH3MaxVideoGeneration,
} from "@/lib/fal/requestH3MaxVideo";
import type { RenderBackend } from "../contract";

const RENDER_RESOLUTION = "480P";
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

// $/sec at 480P. 768P/1080P kept for a future resolution option, unused by either backend today.
const H3_MAX_COST_PER_SEC_USD: Record<string, number> = {
  "480P": 0.025,
  "768P": 0.04,
  "1080P": 0.08,
};

const costFor = (durationSec: number): number =>
  durationSec * (H3_MAX_COST_PER_SEC_USD[RENDER_RESOLUTION] ?? 0);

export type VideoRenderResult = {
  videoUrl: string;
  seed?: number;
  costUsd: number;
};

export type VideoBackend = {
  render: (input: {
    prompt: string;
    seedFrameUrl: string;
    durationSec: number;
    // Anchored idle loops: render start = end on this frame. Ignored by backends that report
    // supportsEndFrame: false.
    endFrameUrl?: string;
  }) => Promise<VideoRenderResult>;
  // Whether `render`'s endFrameUrl is honoured. The reference backend has no end-frame parameter.
  supportsEndFrame: boolean;
};

export const turboBackend: VideoBackend = {
  supportsEndFrame: true,
  render: async ({ prompt, seedFrameUrl, durationSec, endFrameUrl }) => {
    const submitted = await submitH3MaxVideoGeneration({
      prompt,
      image_url: seedFrameUrl,
      end_image_url: endFrameUrl,
      duration: durationSec,
      resolution: RENDER_RESOLUTION,
      prompt_expansion_mode: "disabled",
      enable_safety_checker: false,
    });
    const result = await pollH3MaxVideoUntilComplete({
      statusUrl: submitted.status_url,
      responseUrl: submitted.response_url,
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    return {
      videoUrl: result.video.url,
      seed: result.seed,
      costUsd: costFor(durationSec),
    };
  },
};

export const referenceBackend: VideoBackend = {
  supportsEndFrame: false,
  // endFrameUrl is intentionally ignored: the reference-to-video model has no end-frame parameter.
  render: async ({ prompt, seedFrameUrl, durationSec }) => {
    // Single reference image only — feeding the original photo as a live second reference every
    // clip kept pulling its nudity back in; identity anchoring runs separately via frameGuard's repair.
    const submitted = await submitH3MaxReferenceVideoGeneration({
      prompt,
      reference_image_urls: [seedFrameUrl],
      duration: durationSec,
      resolution: RENDER_RESOLUTION,
      // Full-screen portrait player; "adaptive" would copy the source photo's own (landscape) ratio.
      aspect_ratio: "9:16",
      prompt_expansion_mode: "disabled",
      enable_safety_checker: false,
    });
    const result = await pollH3MaxReferenceVideoUntilComplete({
      statusUrl: submitted.status_url,
      responseUrl: submitted.response_url,
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    return {
      videoUrl: result.video.url,
      seed: result.seed,
      costUsd: costFor(durationSec),
    };
  },
};

export const renderBackendFor = (backend: RenderBackend): VideoBackend =>
  backend === "reference" ? referenceBackend : turboBackend;
