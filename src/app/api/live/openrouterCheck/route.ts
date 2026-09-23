import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";

type KeyInfo = {
  data?: {
    limit?: number | null;
    limit_remaining?: number | null;
    usage?: number;
    is_free_tier?: boolean;
  };
};

// Confirms the deployed OpenRouter key authenticates; returns spend numbers only, never the key or its label.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.OPENROUTER_API_KEY) {
    return NextResponse.json({ ok: false, reason: "not configured" });
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, status: res.status });
    }
    const { data } = (await res.json()) as KeyInfo;
    return NextResponse.json({
      ok: true,
      limit: data?.limit ?? null,
      limitRemaining: data?.limit_remaining ?? null,
      usage: data?.usage ?? null,
      freeTier: data?.is_free_tier ?? null,
    });
  } catch (error) {
    console.warn("live/openrouterCheck: request failed", error);
    return NextResponse.json({ ok: false, reason: "request failed" });
  }
}
