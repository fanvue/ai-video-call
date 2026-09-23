import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/live/server/generateClip", () => ({ generateClip: vi.fn() }));
vi.mock("@/lib/live/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/live/contract")>();
  return {
    ...actual,
    // The route's own schemas are covered elsewhere; these tests are about the transport.
    clipRequestSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
    clipResultSchema: { parse: (data: unknown) => data },
  };
});

const { getCurrentUser } = await import("@/lib/fanvue");
const { generateClip } = await import("@/lib/live/server/generateClip");
const { POST } = await import("./route");

const post = (accept?: string) =>
  new Request("https://example.com/api/live/clip", {
    method: "POST",
    headers: accept ? { Accept: accept } : {},
    body: JSON.stringify({ job: { kind: "reply" } }),
  });

const lines = async (res: Response) =>
  (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

beforeEach(() => {
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u" } as never);
  vi.mocked(generateClip).mockReset();
});

describe("POST /api/live/clip", () => {
  it("returns plain JSON without the stream Accept type", async () => {
    vi.mocked(generateClip).mockResolvedValue({ clipId: "c1" } as never);
    const res = await POST(post());
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ clipId: "c1" });
    expect(vi.mocked(generateClip).mock.calls[0]).toHaveLength(1);
  });

  it("streams a rendered line ahead of the result when asked for NDJSON", async () => {
    vi.mocked(generateClip).mockImplementation(async (_req, onRendered) => {
      onRendered?.("https://example.com/raw.mp4");
      return { clipId: "c1" } as never;
    });
    const res = await POST(post("application/x-ndjson"));
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await lines(res)).toEqual([
      { type: "rendered", videoUrl: "https://example.com/raw.mp4" },
      { type: "result", result: { clipId: "c1" } },
    ]);
  });

  it("ends the stream on an error line when generation fails", async () => {
    vi.mocked(generateClip).mockRejectedValue(new Error("fal down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(post("application/x-ndjson"));
    expect(await lines(res)).toEqual([
      { type: "error", error: "Clip generation failed" },
    ]);
  });

  it("rejects an unauthenticated caller before streaming", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    const res = await POST(post("application/x-ndjson"));
    expect(res.status).toBe(401);
    expect(generateClip).not.toHaveBeenCalled();
  });
});
