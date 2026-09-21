import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";

export const maxDuration = 60;

// Only the WebRTC signalling calls the SDK's wma extension makes; the key never fronts anything else.
const ALLOWED_TARGETS = new Set([
  "https://wma.fal.run/session",
  "https://wma.fal.run/ice",
  "https://wma.fal.run/session/heartbeat",
]);

const TARGET_URL_HEADER = "x-fal-target-url";

const handle = async (request: Request): Promise<Response> => {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const target = request.headers.get(TARGET_URL_HEADER) ?? "";
  let normalized = "";
  try {
    const url = new URL(target);
    normalized = `${url.origin}${url.pathname}`;
  } catch {
    return NextResponse.json({ error: "Bad target" }, { status: 400 });
  }
  if (!ALLOWED_TARGETS.has(normalized)) {
    return NextResponse.json({ error: "Target not allowed" }, { status: 403 });
  }

  const body = request.method === "POST" ? await request.text() : undefined;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: {
        // The only place FAL_KEY fronts director mode; the browser never sees it.
        Authorization: `Key ${env.FAL_KEY}`,
        "Content-Type":
          request.headers.get("content-type") ?? "application/json",
        Accept: "application/json",
      },
      body,
    });
  } catch (error) {
    console.warn("fal/proxy: upstream request failed", error);
    return NextResponse.json({ error: "Could not reach fal" }, { status: 502 });
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
};

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
