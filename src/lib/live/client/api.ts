// Thin fetch wrappers for the server routes. See docs/LIVE_ENGINE.md.
import {
  clipResultSchema,
  clipSwapReportSchema,
  type ClipRequest,
  type ClipResult,
  type CreatorProfile,
  type InputChannel,
  type SceneId,
  type SpeechMode,
  type SwapProfile,
  type TranscriptEntry,
} from "@/lib/live/contract";
import type { ReferenceUploadResult } from "@/lib/live/client/useLiveSession";
import type {
  LongLiveComposeInput,
  LongLiveComposed,
  LongLiveObservation,
  LongLiveObserveInput,
  LongLiveTicket,
} from "@/lib/live/client/longliveStream";
import { z } from "zod";

const readFileAsBase64 = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

// Vercel rejects bodies over 4.5 MB (413) and base64 adds a third, so large photos are re-encoded to a JPEG well under that.
const MAX_UPLOAD_BYTES = 2_500_000;
const MAX_UPLOAD_EDGE = 2048;

const shrinkForUpload = async (file: File): Promise<Blob> => {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    MAX_UPLOAD_EDGE / Math.max(bitmap.width, bitmap.height),
  );
  if (scale === 1 && file.size <= MAX_UPLOAD_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.92, 0.85, 0.75]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
  }
  throw new Error(
    "That photo is too large to upload. Please use a smaller one.",
  );
};

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    (T & { error?: string }) | null;
  if (!res.ok || !data) {
    throw new Error(data?.error ?? `Request to ${url} failed (${res.status})`);
  }
  return data;
};

export const renderClip = async (req: ClipRequest): Promise<ClipResult> => {
  const raw = await postJson<unknown>("/api/live/clip", req);
  return clipResultSchema.parse(raw);
};

const swapResultSchema = z.object({
  videoUrl: z.string().min(1),
  // Absent when the swap failed open to the unswapped clip.
  lastFrameUrl: z.string().min(1).optional(),
  costUsd: z.number().min(0),
  report: clipSwapReportSchema,
});
export type SwapRenderedClipResult = z.infer<typeof swapResultSchema>;

// Second phase of a swap-mode clip: finishes the face swap of a clip that came back with swap.status "pending".
export const swapRenderedClip = async (
  result: ClipResult,
  referenceImageUrl: string,
  swapProfile?: SwapProfile,
): Promise<SwapRenderedClipResult> => {
  const raw = await postJson<unknown>("/api/live/swap", {
    videoUrl: result.videoUrl,
    referenceImageUrl,
    jobKind: result.jobKind,
    swapProfile,
  });
  return swapResultSchema.parse(raw);
};

export type UpscaleSeedResult = { url: string | null; costUsd: number };

// Called after a clip already resolved (see pipeline.ts) — never blocks clip start.
export const upscaleSeed = async (
  frameUrl: string,
): Promise<UpscaleSeedResult> =>
  postJson<UpscaleSeedResult>("/api/live/upscaleSeed", { frameUrl });

export const uploadReference = async (
  file: File,
  sceneId: SceneId,
  stage = true,
  faceCrop = true,
): Promise<ReferenceUploadResult> => {
  // The server only accepts jpeg/png; HEIC and webp are rejected upfront rather than as a 400.
  if (file.type && file.type !== "image/jpeg" && file.type !== "image/png") {
    throw new Error("Please use a JPEG or PNG photo.");
  }
  const upload = await shrinkForUpload(file);
  const imageBase64 = await readFileAsBase64(upload);
  const contentType = upload.type === "image/png" ? "image/png" : "image/jpeg";
  return postJson<ReferenceUploadResult>("/api/live/reference", {
    imageBase64,
    contentType,
    sceneId,
    stage,
    faceCrop,
  });
};

// Mints a short-lived, lucy-app-scoped fal token for the browser's lucy WebRTC session.
export const fetchLucyToken = async (): Promise<string> => {
  const { token } = await postJson<{ token: string }>(
    "/api/live/lucyToken",
    {},
  );
  return token;
};

// Mints a two-minute ticket for the LongLive socket; the signing secret stays on the server.
export const fetchLongLiveTicket = async (): Promise<LongLiveTicket> =>
  postJson<LongLiveTicket>("/api/live/longliveTicket", {});

export const composeLongLivePrompt = async (
  input: LongLiveComposeInput,
): Promise<LongLiveComposed> =>
  postJson<LongLiveComposed>("/api/live/longlivePrompt", input);

// The frame goes up inline, like a reference photo, and is never stored.
export const observeLongLiveWardrobe = async ({
  frame,
  ...input
}: LongLiveObserveInput): Promise<LongLiveObservation> =>
  postJson<LongLiveObservation>("/api/live/longliveObserve", {
    ...input,
    frameBase64: await readFileAsBase64(frame),
  });

// Fire-and-forget from the setup screen when LongLive is picked; the model load is the whole cold start.
export const warmLongLive = async (): Promise<void> => {
  await postJson<{ warm: boolean }>("/api/live/longliveWarm", {});
};

// Fire-and-forget at session start in swap mode so the GPU container is loading while the first clip renders.
export const warmSwap = async (): Promise<void> => {
  await postJson<{ warm: boolean }>("/api/live/swapWarm", {});
};

export type TelemetryDetail = Record<string, string | number | boolean | null>;

// Fire-and-forget: playback stalls are invisible in production logs otherwise.
export const reportTelemetry = (
  event: string,
  detail: TelemetryDetail = {},
) => {
  postJson<{ ok: boolean }>("/api/live/telemetry", { event, detail }).catch(
    () => undefined,
  );
};

export const composeDirectorPrompt = async (input: {
  creator: CreatorProfile;
  transcript: TranscriptEntry[];
  world: string;
  requestText: string;
  channel: InputChannel;
  speechMode: SpeechMode;
}): Promise<{ prompt: string; reply: string }> =>
  postJson<{ prompt: string; reply: string }>(
    "/api/live/directorPrompt",
    input,
  );
