// Small shared primitives: ids, signed tickets, constant-time compare.
import crypto from "node:crypto";

export const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;

export const newToken = () => crypto.randomBytes(24).toString("base64url");

/** Constant-time string compare that never throws on length mismatch. */
export function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** `payload.signature`, both base64url. Signature = HMAC-SHA256(key, payload). */
export function signTicket(key, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verify and decode a ticket. Returns the payload, or null when the signature
 * is wrong or the ticket has expired. Never throws on malformed input.
 */
export function readTicket(key, ticket, now = Date.now()) {
  const [body, sig] = String(ticket ?? "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", key).update(body).digest("base64url");
  if (!tokenMatches(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== "number" || payload.exp < now) return null;
  return payload;
}