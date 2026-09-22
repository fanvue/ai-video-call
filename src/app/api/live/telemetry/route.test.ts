import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUser = vi.fn();
vi.mock("@/lib/fanvue", () => ({
  getCurrentUser: () => getCurrentUser(),
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/live/telemetry", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/live/telemetry", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: "user-1" });
  });

  it("rejects anonymous callers", async () => {
    getCurrentUser.mockResolvedValue(null);
    expect((await post({ event: "bufferEmpty" })).status).toBe(401);
  });

  it("logs the event with its flattened detail", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await post({
      event: "bufferEmpty",
      detail: { clip: "idle", heldMs: 1200 },
    });
    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledWith(
      "live/telemetry: bufferEmpty clip=idle heldMs=1200",
    );
    log.mockRestore();
  });

  it("rejects a malformed body", async () => {
    expect((await post({ detail: "x" })).status).toBe(400);
  });
});
