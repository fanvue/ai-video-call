import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "swap-persona-route-secret-0123456789abcdef";
const mockEnv: { SWAP_TOKEN?: string; SWAP_PERSONA_URL?: string } = {};

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/env", () => ({ env: mockEnv }));

const { getCurrentUser } = await import("@/lib/fanvue");
const { GET } = await import("./route");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mockEnv.SWAP_TOKEN = SECRET;
  mockEnv.SWAP_PERSONA_URL = "https://example-swap-persona.modal.run";
  delete process.env.PERSONA_REGISTRAR_DOMAIN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/live/swapPersonas", () => {
  it("rejects unauthenticated requests", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    expect((await GET()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns only ids and notes, with a server-minted ticket", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      uuid: "u",
      email: "x@notfanvue.com",
    } as never);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          personas: [
            {
              id: "synth-persona-01",
              note: "Seed",
              rightsHolder: "Fanvue",
              file: "synth-persona-01.jpg",
            },
          ],
        }),
      ),
    );
    const response = await GET();
    expect(await response.json()).toEqual({
      personas: [{ id: "synth-persona-01", note: "Seed" }],
      canRegister: false,
    });
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.origin + url.pathname).toBe(
      "https://example-swap-persona.modal.run/personas",
    );
    expect(url.searchParams.get("ticket")).toMatch(
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
  });

  it("tells a Fanvue account it can register", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      uuid: "u",
      email: "x@fanvue.com",
    } as never);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ personas: [] })));
    expect((await (await GET()).json()).canRegister).toBe(true);
  });

  it("falls back to an empty list when the service is down or malformed", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ uuid: "u" } as never);
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await (await GET()).json()).toEqual({
      personas: [],
      canRegister: false,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ personas: [{ id: "BAD ID", note: "" }] })),
    );
    expect((await (await GET()).json()).personas).toEqual([]);
  });

  it("fails closed without the swap persona store configured, never LongLive's", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      uuid: "u",
      email: "x@fanvue.com",
    } as never);
    delete mockEnv.SWAP_PERSONA_URL;
    expect((await GET()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
