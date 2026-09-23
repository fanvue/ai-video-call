import { createHmac, randomUUID } from "node:crypto";

// Only the WebSocket handshake needs it; the Modal service checks exp once, at connect.
const TICKET_TTL_SEC = 120;

// base64url(JSON {sid, exp}) + "." + base64url(HMAC-SHA256(secret, payloadPart)); exp is unix seconds, verified by services/longlive.
export const mintLongLiveTicket = (
  secret: string,
  nowMs: number,
  sid: string = randomUUID(),
): { ticket: string; expiresAt: number } => {
  const exp = Math.floor(nowMs / 1000) + TICKET_TTL_SEC;
  const payloadPart = Buffer.from(JSON.stringify({ sid, exp })).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(payloadPart)
    .digest("base64url");
  return { ticket: `${payloadPart}.${signature}`, expiresAt: exp * 1000 };
};
