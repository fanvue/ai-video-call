// Thin fetch wrappers for the server routes. See docs/LIVE_ENGINE.md.
import {
  CLIP_STREAM_CONTENT_TYPE,
  clipResultSchema,
  clipSwapReportSchema,
  type ClipRequest,
  type ClipResult,
  type CreatorProfile,
  type InputChannel,
  personaOptionSchema,
  type PersonaOption,
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
    | (T & { error?: string })
    | null;
  if (!res.ok || !data) {
    throw new Error(data?.error ?? `Request to ${url} failed (${res.status})`);
  }
  return data;
};

const clipStreamLineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rendered"), videoUrl: z.string().min(1) }),
  z.object({ type: z.literal("result"), result: clipResultSchema }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

// With onRendered, reads the route's NDJSON stream so the caller hears the unswapped clip's url before the seed swap finishes.
export const renderClip = async (
  req: ClipRequest,
  onRendered?: (videoUrl: string) => void,
): Promise<ClipResult> => {
  if (!onRendered) {
    const raw = await postJson<unknown>("/api/live/clip", req);
    return clipResultSchema.parse(raw);
  }
  const res = await fetch("/api/live/clip", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: CLIP_STREAM_CONTENT_TYPE,
    },
    body: JSON.stringify(req),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      data?.error ?? `Request to /api/live/clip failed (${res.status})`,
    );
  }
  // A route or proxy that ignores the Accept header still answers with the plain result.
  if (!res.headers.get("content-type")?.includes(CLIP_STREAM_CONTENT_TYPE)) {
    return clipResultSchema.parse(await res.json());
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffered += value ?? "";
    const lines = buffered.split("\n");
    buffered = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parsed = clipStreamLineSchema.parse(JSON.parse(line));
      if (parsed.type === "rendered") {
        onRendered(parsed.videoUrl);
      } else if (parsed.type === "result") {
        void reader.cancel();
        return parsed.result;
      } else {
        throw new Error(parsed.error);
      }
    }
    if (done) {
      throw new Error("/api/live/clip stream ended without a result");
    }
  }
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
  result: Pick<ClipResult, "videoUrl" | "jobKind">,
  personaId: string | undefined,
  swapProfile?: SwapProfile,
  swapFaceLock?: boolean,
  swapHandMask?: boolean,
): Promise<SwapRenderedClipResult> => {
  const raw = await postJson<unknown>("/api/live/swap", {
    videoUrl: result.videoUrl,
    personaId,
    jobKind: result.jobKind,
    swapProfile,
    swapFaceLock,
    swapHandMask,
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

const personaListingSchema = z.object({
  personas: z.array(personaOptionSchema),
  canRegister: z.boolean(),
});

export type PersonaListing = z.infer<typeof personaListingSchema>;

// LongLive and swap mode keep separate lists: swap mode's comes from the swap app's CPU persona store.
const listPersonasAt = async (path: string): Promise<PersonaListing> => {
  const res = await fetch(path);
  const parsed = personaListingSchema.safeParse(
    await res.json().catch(() => null),
  );
  if (!res.ok || !parsed.success) {
    throw new Error(`Could not load personas (${res.status})`);
  }
  return parsed.data;
};

export const fetchPersonas = () => listPersonasAt("/api/live/personas");

export const fetchSwapPersonas = () => listPersonasAt("/api/live/swapPersonas");

// The attestation is required server side; the checkbox only gates the button.
const registerPersonaAt = async (
  path: string,
  file: File,
  name: string,
): Promise<{ id: PersonaOption["id"]; created: boolean }> => {
  if (file.type && file.type !== "image/jpeg" && file.type !== "image/png") {
    throw new Error("Please use a JPEG or PNG photo.");
  }
  const upload = await shrinkForUpload(file);
  return postJson<{ id: string; created: boolean }>(path, {
    imageBase64: await readFileAsBase64(upload),
    contentType: upload.type === "image/png" ? "image/png" : "image/jpeg",
    name,
    attested: true,
  });
};

export const registerPersona = (file: File, name: string) =>
  registerPersonaAt("/api/live/personaRegister", file, name);

export const registerSwapPersona = (file: File, name: string) =>
  registerPersonaAt("/api/live/swapPersonaRegister", file, name);

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
