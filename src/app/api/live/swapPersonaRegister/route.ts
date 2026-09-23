import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";
import {
  mintPersonaRegisterToken,
  personaIdForImage,
  personaRegistrar,
  registrarDomain,
  sha256Hex,
} from "@/lib/live/server/personaRegistrar";

// Swap mode's registration writes the same persona-faces volume through the swap app's CPU persona store; same gates as LongLive's route.
export const maxDuration = 60;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAGIC: Record<"image/jpeg" | "image/png", number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

// So testers can tell registered faces apart in the picker; the file itself stays hash-named.
const NAME_RE = /^[A-Za-z0-9 .\-_']+$/;

// Unknown keys (an "email", say) are stripped: who may register comes from the session alone.
const bodySchema = z.object({
  imageBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4),
  contentType: z.union([z.literal("image/jpeg"), z.literal("image/png")]),
  name: z.string().trim().min(1).max(40).regex(NAME_RE, {
    error: "Name may only use letters, digits, spaces, and . - _ '",
  }),
  attested: z.literal(true, {
    error:
      "Confirm this is a Fanvue-owned AI creator likeness, not a real person",
  }),
});

const serviceReplySchema = z.object({ id: z.string(), created: z.boolean() });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!registrarDomain()) {
    return NextResponse.json(
      { error: "Persona registration is disabled" },
      { status: 403 },
    );
  }
  const registrar = personaRegistrar(user);
  if (!registrar) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (!env.SWAP_TOKEN || !env.SWAP_PERSONA_URL) {
    return NextResponse.json(
      { error: "Swap persona store is not configured" },
      { status: 503 },
    );
  }
  const { imageBase64, contentType, name } = parsed.data;
  const image = Buffer.from(imageBase64, "base64");
  const magic = MAGIC[contentType];
  if (
    image.length === 0 ||
    image.length > MAX_IMAGE_BYTES ||
    !magic.every((byte, index) => image[index] === byte)
  ) {
    return NextResponse.json(
      { error: "Image does not match its content type" },
      { status: 400 },
    );
  }
  const sha256 = sha256Hex(image);
  const token = mintPersonaRegisterToken(
    env.SWAP_TOKEN,
    Date.now(),
    registrar.uuid,
    sha256,
  );
  try {
    const response = await fetch(
      new URL("/personas/register", env.SWAP_PERSONA_URL),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Re-encoded from the checked bytes, so the service hashes exactly what the token names.
        body: JSON.stringify({
          token,
          imageBase64: image.toString("base64"),
          contentType,
          name,
        }),
        signal: AbortSignal.timeout(50_000),
      },
    );
    const reply = serviceReplySchema.safeParse(
      await response.json().catch(() => null),
    );
    if (
      !response.ok ||
      !reply.success ||
      reply.data.id !== personaIdForImage(sha256)
    ) {
      return NextResponse.json(
        { error: `Registration failed (${response.status})` },
        { status: 502 },
      );
    }
    // The one audit line: who registered which image, by id and hash only.
    console.info(
      `live/swapPersonaRegister: user=${registrar.uuid} sha256=${sha256}`,
    );
    return NextResponse.json({
      id: personaIdForImage(sha256),
      created: reply.data.created,
    });
  } catch {
    return NextResponse.json({ error: "Registration failed" }, { status: 502 });
  }
}
