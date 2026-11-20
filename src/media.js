// Media tickets: short-lived, HMAC-signed, one binding-scoped address per item.
//
// The envelope carries an ADDRESS, not bytes. Bytes in the envelope would turn
// this service into a storage service with a quota problem, and would put
// multi-megabyte images into every subscriber call.
//
// The address is opaque and signed: it names a binding + platform message id +
// item index, expires in minutes, and is the only thing the media route will
// fetch. A caller cannot make fd-bot fetch an arbitrary URL — the SSRF surface
// is closed here, the same way paas' file route closes it with an allowlist
// plus a realpath check.
import { signTicket, readTicket } from "./ids.js";

export function createMediaTickets({ secret, ttlMs = 5 * 60_000, publicBaseUrl = null, now = Date.now }) {
  const base = (publicBaseUrl || "").replace(/\/+$/, "");

  /** One address per media item of one inbound message. */
  function issueFor({ bindingId, platformMessageId, index, kind, mime }) {
    const ticket = signTicket(secret, {
      b: bindingId,
      m: platformMessageId,
      i: index,
      k: kind,
      t: mime ?? null,
      exp: now() + ttlMs,
    });
    return `${base}/v1/media/${ticket}`;
  }

  /** Verify a media ticket. Returns { bindingId, platformMessageId, index, kind, mime } or null. */
  function read(ticket) {
    const p = readTicket(secret, ticket, now());
    if (!p) return null;
    return { bindingId: p.b, platformMessageId: p.m, index: p.i, kind: p.k, mime: p.t ?? null };
  }

  return { issueFor, read };
}