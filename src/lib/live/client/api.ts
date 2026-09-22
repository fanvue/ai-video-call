// Thin fetch wrappers for the server routes. See docs/LIVE_ENGINE.md.
import {
  clipResultSchema,
  type ClipRequest,
  type ClipResult,
  type CreatorProfile,
  type InputChannel,
  type SpeechMode,
  type TranscriptEntry,
} from "@/lib/live/contract";
import type { ReferenceUploadResult } from "@/lib/live/client/useLiveSession";

const readFileAsBase64 = (file: File): Promise<string> =>
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

export type UpscaleSeedResult = { url: string | null; costUsd: number };

// Called after a clip already resolved (see pipeline.ts) — never blocks clip start.
export const upscaleSeed = async (
  frameUrl: string,
): Promise<UpscaleSeedResult> =>
  postJson<UpscaleSeedResult>("/api/live/upscaleSeed", { frameUrl });

export const uploadReference = async (
  file: File,
): Promise<ReferenceUploadResult> => {
  const imageBase64 = await readFileAsBase64(file);
  // The server only accepts jpeg/png; HEIC and webp are rejected upfront rather than as a 400.
  const contentType = file.type === "image/png" ? "image/png" : "image/jpeg";
  if (file.type && file.type !== "image/jpeg" && file.type !== "image/png") {
    throw new Error("Please use a JPEG or PNG photo.");
  }
  return postJson<ReferenceUploadResult>("/api/live/reference", {
    imageBase64,
    contentType,
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

export const fetchSwapSession = async (): Promise<string> => {
  const { url } = await postJson<{ url: string }>("/api/live/swapSession", {});
  return url;
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
