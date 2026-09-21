import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";

export const maxDuration = 30;

// Unlike director's wma.fal.run bridge, lucy only calls context.connect (token rides the WS URL query param), so a real fal.run temp token works and no proxy is needed — see lucyStream.ts.
const LUCY_ENDPOINT_ID = "decart/lucy-2-5/realtime";

// Per the SDK's own parseEndpointId (node_modules/@fal-ai/client/src/utils.js), allowed_apps takes only the middle "alias" segment of a 3-part endpoint id ("lucy-2-5"), not the full id.
const LUCY_APP_ALIAS = LUCY_ENDPOINT_ID.split("/")[1] ?? LUCY_ENDPOINT_ID;

const FAL_TOKENS_URL = "https://rest.fal.ai/tokens/";
// Short-lived by design; only the handshake needs it, not the whole WebRTC session.
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
        // The only place the real FAL_KEY is ever used for lucy mode; it never reaches the client.
        Authorization: `Key ${env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        allowed_apps: [LUCY_APP_ALIAS],
        token_expiration: TOKEN_EXPIRATION_SECONDS,
      }),
    });
  } catch (error) {
    console.warn("live/lucyToken: fal token request failed", error);
    return NextResponse.json({ error: "Could not reach fal" }, { status: 502 });
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    console.warn("live/lucyToken: fal token mint rejected", res.status);
    return NextResponse.json(
      { error: "Could not mint lucy token" },
      { status: 502 },
    );
  }

  // Same unwrap the SDK's getTemporaryAuthToken performs: some proxies wrap the token in { detail }.
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
    console.warn("live/lucyToken: unexpected token response shape");
    return NextResponse.json(
      { error: "Could not mint lucy token" },
      { status: 502 },
    );
  }

  // Never log the token itself.
  return NextResponse.json({ token });
}
