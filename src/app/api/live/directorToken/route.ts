import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";

export const maxDuration = 30;

// The one endpoint director mode is ever allowed to open a live session against.
const DIRECTOR_ENDPOINT_ID = "minimax/h3-max/director";

// Per the installed SDK's own getTemporaryAuthToken (src/auth.js / src/utils.js parseEndpointId),
// allowed_apps takes only the middle "alias" segment ("h3-max"), not the full three-part id.
const directorAppAlias =
  DIRECTOR_ENDPOINT_ID.split("/")[1] ?? DIRECTOR_ENDPOINT_ID;

const FAL_TOKENS_URL = "https://rest.fal.ai/tokens/";
// fal's realtime tokens are short-lived by design; the WebRTC session itself stays up long after
// the handshake that consumes this token.
const TOKEN_EXPIRATION_SECONDS = 120;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let res: Response;
  try {
    res = await fetch(FAL_TOKENS_URL, {
      method: "POST",
      headers: {
        // The only place the real FAL_KEY is ever used for director mode; it never reaches the client.
        Authorization: `Key ${env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        allowed_apps: [directorAppAlias],
        token_expiration: TOKEN_EXPIRATION_SECONDS,
      }),
    });
  } catch (error) {
    console.warn("live/directorToken: fal token request failed", error);
    return NextResponse.json({ error: "Could not reach fal" }, { status: 502 });
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    console.warn("live/directorToken: fal token mint rejected", res.status);
    return NextResponse.json(
      { error: "Could not mint director token" },
      { status: 502 },
    );
  }

  // Same unwrap the SDK's own getTemporaryAuthToken performs: older proxies wrap the bare token
  // string in { detail: string }.
  const token =
    typeof data === "string"
      ? data
      : data &&
          typeof data === "object" &&
          "detail" in data &&
          typeof (data as { detail: unknown }).detail === "string"
        ? (data as { detail: string }).detail
        : null;

  if (!token) {
    console.warn("live/directorToken: unexpected token response shape");
    return NextResponse.json(
      { error: "Could not mint director token" },
      { status: 502 },
    );
  }

  // Never log the token itself.
  return NextResponse.json({ token });
}
