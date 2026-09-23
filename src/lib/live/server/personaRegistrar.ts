import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

const DEFAULT_REGISTRAR_DOMAIN = "fanvue.com";
// Long enough for a cold LongLive container to load before it checks the token.
const REGISTER_TOKEN_TTL_SEC = 300;

// Read raw, not through env.ts: its emptyStringAsUndefined would turn an explicit "" (off) back into the default domain.
export const registrarDomain = (
  raw: string | undefined = process.env.PERSONA_REGISTRAR_DOMAIN,
): string | null => {
  if (raw === undefined) {
    return DEFAULT_REGISTRAR_DOMAIN;
  }
  const domain = raw.trim().toLowerCase();
  return domain ? domain : null;
};

// Last "@" so a quoted local part cannot smuggle a second domain; null for anything that is not local@domain.
export const emailDomain = (email: unknown): string | null => {
  if (typeof email !== "string") {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const local = email.slice(0, at).trim();
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!local || !domain || /\s/.test(domain)) {
    return null;
  }
  return domain;
};

const sessionUserSchema = z.object({
  uuid: z.string().min(1),
  email: z.string(),
  emailVerified: z.boolean().optional(),
  isEmailVerified: z.boolean().optional(),
});

// Only ever called with getCurrentUser()'s result: the email comes from the Fanvue session, never from the request body.
export const personaRegistrar = (
  user: unknown,
  domain: string | null = registrarDomain(),
): { uuid: string } | null => {
  if (!domain) {
    return null;
  }
  const parsed = sessionUserSchema.safeParse(user);
  if (!parsed.success) {
    return null;
  }
  const { uuid, email, emailVerified, isEmailVerified } = parsed.data;
  if (emailVerified === false || isEmailVerified === false) {
    return null;
  }
  return emailDomain(email) === domain ? { uuid } : null;
};

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const personaIdForImage = (sha256: string): string =>
  `upload-${sha256.slice(0, 12)}`;

// Same wire format as the stream ticket, but purpose-bound and tied to one image hash; services/longlive checks both.
export const mintPersonaRegisterToken = (
  secret: string,
  nowMs: number,
  uid: string,
  sha256: string,
): string => {
  const exp = Math.floor(nowMs / 1000) + REGISTER_TOKEN_TTL_SEC;
  const payloadPart = Buffer.from(
    JSON.stringify({ purpose: "persona-register", uid, sha256, exp }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payloadPart)
    .digest("base64url");
  return `${payloadPart}.${signature}`;
};
