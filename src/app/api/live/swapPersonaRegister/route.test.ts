import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "swap-persona-route-secret-0123456789abcdef";
const mockEnv: { SWAP_TOKEN?: string; SWAP_PERSONA_URL?: string } = {};

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/env", () => ({ env: mockEnv }));

const { getCurrentUser } = await import("@/lib/fanvue");
const { POST } = await import("./route");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const SHA = createHash("sha256").update(JPEG).digest("hex");

const fanvueUser = { uuid: "user-uuid-1", email: "x@fanvue.com" };

const request = (body: unknown) =>
  new Request("https://app.test/api/live/swapPersonaRegister", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const validBody = (extra: Record<string, unknown> = {}) => ({
  imageBase64: JPEG.toString("base64"),
  contentType: "image/jpeg",
  name: "Ava Test",
  attested: true,
  ...extra,
});

const fetchMock = vi.fn();

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({ id: `upload-${SHA.slice(0, 12)}`, created: true }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  mockEnv.SWAP_TOKEN = SECRET;
  mockEnv.SWAP_PERSONA_URL = "https://example-swap-persona.modal.run";
  delete process.env.PERSONA_REGISTRAR_DOMAIN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PERSONA_REGISTRAR_DOMAIN;
});

describe("POST /api/live/swapPersonaRegister", () => {
  it("rejects unauthenticated requests", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    expect((await POST(request(validBody()))).status).toBe(401);
  });

  it.each(["x@notfanvue.com", "x@fanvue.com.evil.io", "x@sub.fanvue.com"])(
    "answers 403 for %s and never calls the service",
    async (email) => {
      vi.mocked(getCurrentUser).mockResolvedValue({
        uuid: "user-uuid-2",
        email,
      } as never);
      expect((await POST(request(validBody()))).status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("ignores a client-supplied email field", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      uuid: "user-uuid-2",
      email: "x@notfanvue.com",
    } as never);
    const response = await POST(request(validBody({ email: "x@fanvue.com" })));
    expect(response.status).toBe(403);
    vi.mocked(getCurrentUser).mockResolvedValue(fanvueUser as never);
    const allowed = await POST(
      request(validBody({ email: "x@notfanvue.com" })),
    );
    expect(allowed.status).toBe(200);
  });

  it("is disabled for everyone when PERSONA_REGISTRAR_DOMAIN is set empty", async () => {
    process.env.PERSONA_REGISTRAR_DOMAIN = "";
    vi.mocked(getCurrentUser).mockResolvedValue(fanvueUser as never);
    const response = await POST(request(validBody()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Persona registration is disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts an uppercase Fanvue email", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      uuid: "user-uuid-1",
      email: "X@FANVUE.COM",
    } as never);
    expect((await POST(request(validBody()))).status).toBe(200);
  });

  it("answers 400 without the attestation", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(fanvueUser as never);
    for (const attested of [undefined, false, "true", 1]) {
      const response = await POST(request(validBody({ attested })));
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 400 when the bytes do not match the content type", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(fanvueUser as never);
    const response = await POST(
      request(validBody({ contentType: "image/png" })),
    );
    expect(response.status).toBe(400);
  });

  it("answers 400 for a missing, empty or out-of-charset name", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(fanvueUser as never);
    for (const name of [
      undefined,
      "",
      "   ",
      "x".repeat(41),
      "Ava <3",
      "Ava/2",
    ]) {
      const response = await POST(request(validBody({ name })));
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims the name and accepts the allowed charset", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(fanvueUser as never);
    for (const name of ["Ava", "Ava-Jane_02.5 O'Brien", "  Padded  "]) {
      // A fresh Response per call: the shared beforeEach one's body is single-use.
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: `upload-${SHA.slice(0, 12)}`, created: true }),
          { status: 200 },
        ),
      );
      const response = await POST(request(validBody({ name })));
      expect(response.status).toBe(200);
    }
  });

  it("registers under the hash id, sends a purpose-bound token and logs only the user id and hash", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(fanvueUser as never);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(request(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: `upload-${SHA.slice(0, 12)}`,
      created: true,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://example-swap-persona.modal.run/personas/register",
    );
    const sent = JSON.parse(init.body as string) as {
      token: string;
      imageBase64: string;
      name: string;
    };
    const claims = JSON.parse(
      Buffer.from(sent.token.split(".")[0], "base64url").toString(),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      purpose: "persona-register",
      uid: "user-uuid-1",
      sha256: SHA,
    });
    expect(sent.name).toBe("Ava Test");
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(JSON.stringify(sent)).not.toContain("fanvue.com");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      `live/swapPersonaRegister: user=user-uuid-1 sha256=${SHA}`,
    );
    info.mockRestore();
  });

  it("answers 502 when the service refuses or returns another id", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(fanvueUser as never);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad token" }), { status: 401 }),
    );
    expect((await POST(request(validBody()))).status).toBe(502);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: "upload-000000000000", created: true }),
      ),
    );
    expect((await POST(request(validBody()))).status).toBe(502);
  });

  it("fails closed without the swap persona store configured", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(fanvueUser as never);
    delete mockEnv.SWAP_PERSONA_URL;
    expect((await POST(request(validBody()))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
