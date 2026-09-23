import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintLongLiveTicket } from "./longliveTicket";

const SECRET = "longlive-test-secret-0123456789abcdef";

// Mirrors what the Modal service does: recompute the HMAC over the payload part, then check exp.
const verify = (
  ticket: string,
  secret: string,
  nowMs: number,
): { sid: string; exp: number } | null => {
  const [payloadPart, signature, ...rest] = ticket.split(".");
  if (!payloadPart || !signature || rest.length > 0) return null;
  const expected = createHmac("sha256", secret)
    .update(payloadPart)
    .digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(
    Buffer.from(payloadPart, "base64url").toString("utf8"),
  ) as { sid: string; exp: number };
  return payload.exp > Math.floor(nowMs / 1000) ? payload : null;
};

describe("mintLongLiveTicket", () => {
  const now = Date.UTC(2026, 8, 23, 12, 0, 0);

  it("round-trips through HMAC verification with the same secret", () => {
    const { ticket } = mintLongLiveTicket(SECRET, now, "sid-1");
    expect(verify(ticket, SECRET, now)).toEqual({
      sid: "sid-1",
      exp: now / 1000 + 300,
    });
  });

  it("is two base64url parts with no padding, so it is safe in a query string", () => {
    const { ticket } = mintLongLiveTicket(SECRET, now);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("expires 300 s after minting, in unix seconds, and reports expiresAt in ms", () => {
    const { ticket, expiresAt } = mintLongLiveTicket(SECRET, now);
    expect(expiresAt).toBe(now + 300_000);
    expect(verify(ticket, SECRET, now + 299_000)).not.toBeNull();
    expect(verify(ticket, SECRET, now + 300_000)).toBeNull();
  });

  it("fails verification under a different secret", () => {
    const { ticket } = mintLongLiveTicket(SECRET, now);
    expect(verify(ticket, `${SECRET}-other`, now)).toBeNull();
  });

  it("fails verification when the payload is swapped for another one", () => {
    const { ticket } = mintLongLiveTicket(SECRET, now, "sid-a");
    const { ticket: other } = mintLongLiveTicket(
      SECRET,
      now + 3_600_000,
      "sid-b",
    );
    const forged = `${other.split(".")[0]}.${ticket.split(".")[1]}`;
    expect(verify(forged, SECRET, now)).toBeNull();
  });

  it("uses a fresh random session id per ticket by default", () => {
    const a = verify(mintLongLiveTicket(SECRET, now).ticket, SECRET, now);
    const b = verify(mintLongLiveTicket(SECRET, now).ticket, SECRET, now);
    expect(a?.sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(a?.sid).not.toBe(b?.sid);
  });
});
