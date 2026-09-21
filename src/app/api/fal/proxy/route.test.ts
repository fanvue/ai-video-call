import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/env", () => ({ env: { FAL_KEY: "fal-secret-key" } }));

const { getCurrentUser } = await import("@/lib/fanvue");
const { POST, GET } = await import("./route");

const fetchMock = vi.fn();

const proxyRequest = (target: string, init: RequestInit = {}) =>
  new Request("https://app.example.com/api/fal/proxy", {
    method: "POST",
    body: JSON.stringify({ sdp: "v=0", type: "offer" }),
    ...init,
    headers: {
      "content-type": "application/json",
      "x-fal-target-url": target,
      // A client must not be able to smuggle its own credential upstream.
      authorization: "Key attacker-supplied",
      ...(init.headers ?? {}),
    },
  });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(getCurrentUser).mockReset();
});

describe("/api/fal/proxy", () => {
  it("rejects unauthenticated requests without ever calling fal", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);

    const response = await POST(proxyRequest("https://wma.fal.run/session"));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards an allowlisted WMA call with the server key and only the server key", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ session_id: "s1", sdp: "v=0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await POST(proxyRequest("https://wma.fal.run/session"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session_id: "s1", sdp: "v=0" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://wma.fal.run/session");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Key fal-secret-key" });
    expect(init.body).toBe(JSON.stringify({ sdp: "v=0", type: "offer" }));
  });

  it.each([
    "https://wma.fal.run/anything-else",
    "https://fal.run/fal-ai/some-model",
    "https://rest.fal.ai/tokens/",
    "http://wma.fal.run/session",
    "https://evil.example.com/session?x=https://wma.fal.run/session",
  ])("refuses to front %s", async (target) => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);

    const response = await POST(proxyRequest(target));

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 on a missing or malformed target", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);

    const response = await POST(proxyRequest("not a url"));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes upstream auth failures through instead of masking them", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid key credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await POST(proxyRequest("https://wma.fal.run/session"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid key credentials" });
  });

  it("forwards GET without a body", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ice_servers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await GET(
      proxyRequest("https://wma.fal.run/ice", { method: "GET", body: null }),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});
