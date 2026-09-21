import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/env", () => ({ env: { FAL_KEY: "fal-secret-key" } }));

const { getCurrentUser } = await import("@/lib/fanvue");
const { POST } = await import("./route");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(getCurrentUser).mockReset();
});

describe("POST /api/live/directorToken", () => {
  it("rejects unauthenticated requests without ever calling fal", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);

    const response = await POST();

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scopes the minted token to only the director app alias, never the real FAL_KEY", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => "temp-token-value",
    });

    const response = await POST();
    const data = (await response.json()) as { token: string };

    expect(data.token).toBe("temp-token-value");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://rest.fal.ai/tokens/");
    expect(init.headers).toMatchObject({ Authorization: "Key fal-secret-key" });
    const body = JSON.parse(init.body as string) as {
      allowed_apps: string[];
      token_expiration: number;
    };
    expect(body.allowed_apps).toEqual(["h3-max"]);
    expect(body.token_expiration).toBe(120);
  });

  it("unwraps a legacy { detail } response shape", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ detail: "wrapped-token" }),
    });

    const response = await POST();
    const data = (await response.json()) as { token: string };

    expect(data.token).toBe("wrapped-token");
  });

  it("fails closed (502) on an unexpected response shape rather than leaking it as a token", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    const response = await POST();

    expect(response.status).toBe(502);
  });
});
