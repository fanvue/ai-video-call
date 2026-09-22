import { fal } from "@fal-ai/client";
import { env } from "@/env";

let configured = false;
const ensureConfigured = () => {
  if (!configured) {
    fal.config({ credentials: env.FAL_KEY });
    configured = true;
  }
};

// Serverless replacement for the pandora monorepo's saveFile (S3) + getDurableRawMediaSignedUrl
// upload of the fan's chosen reference photo — see the port report's BLOCKED notes.
export const uploadReferenceImageToFal = async (
  buffer: Buffer,
  contentType: "image/jpeg" | "image/png",
): Promise<string> => {
  const extension = contentType === "image/png" ? "png" : "jpg";
  return uploadToFal(
    buffer,
    `reference-${Date.now()}.${extension}`,
    contentType,
  );
};

export const uploadToFal = async (
  buffer: Buffer,
  fileName: string,
  contentType: string,
): Promise<string> => {
  ensureConfigured();
  const file = new File([new Uint8Array(buffer)], fileName, {
    type: contentType,
  });
  return fal.storage.upload(file);
};
