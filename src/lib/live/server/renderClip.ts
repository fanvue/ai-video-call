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
    // Untouched upload (session.anchorFrameUrl). Only used by backends that support a second,
    // identity-only reference; ignored by single-reference backends like turbo.
    identityReferenceUrl?: string;
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

// Per fal's MiniMax H3 prompting guide, each reference needs an explicit role or the model treats
// it as the current scene — 98fb8bf's unlabeled two-reference attempt snapped pose/wardrobe back to the upload.
const IDENTITY_REFERENCE_PROMPT_PREFIX =
  "Image 1 is for facial identity and likeness only — ignore its pose, clothing, and setting. Image 2 is the current pose, outfit, and scene — match it exactly and continue the action from it. ";

export const referenceBackend: VideoBackend = {
  supportsEndFrame: false,
  // endFrameUrl is intentionally ignored: the reference-to-video model has no end-frame parameter.
  render: async ({
    prompt,
    seedFrameUrl,
    durationSec,
    identityReferenceUrl,
  }) => {
    const useIdentityReference =
      !!identityReferenceUrl && identityReferenceUrl !== seedFrameUrl;
    const submitted = await submitH3MaxReferenceVideoGeneration({
      prompt: useIdentityReference
        ? IDENTITY_REFERENCE_PROMPT_PREFIX + prompt
        : prompt,
      reference_image_urls: useIdentityReference
        ? [identityReferenceUrl, seedFrameUrl]
        : [seedFrameUrl],
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

export const renderBackendFor = (backend: RenderBackend): VideoBackend => {
  // Director is a live WebRTC stream, handled entirely client-side by DirectorSession; it must
  // never reach the clip pipeline — fail loud rather than silently rendering a turbo/reference clip.
  if (backend === "director") {
    throw new Error(
      "renderBackendFor: 'director' is a live-stream backend, not a clip backend",
    );
  }
  // Lucy (client/lucyStream.ts, live) and Swap (server/swapClip.ts, per clip) both post-process
  // the turbo clip backend's own output, so their clips render exactly like turbo's.
  return backend === "reference" ? referenceBackend : turboBackend;
};
