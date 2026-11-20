// The one shape every platform reduces to.
//
// This is deliberately small. Unifying further (rich blocks, cards, buttons)
// would flatten every platform's differences into a least common denominator —
// which is exactly why the open-source chat frameworks cannot cover the other
// half of what we do. Platforms that need richer payloads carry `raw`; the
// consumer interprets it per platform, not us.
import { createMediaTickets } from "./media.js";

/**
 * Build the envelope the subscriber receives.
 *
 * @param {object} p
 * @param {string} p.bindingId
 * @param {string} p.platform
 * @param {object} p.message   normalized by the adapter:
 *   { chatKey, senderId, senderName, text, media:[{kind,mime,bytes?}],
 *     platformMessageId, receivedAt? }
 */
export function buildEnvelope({ bindingId, platform, message, tickets }) {
  const msg = message ?? {};
  const platformMessageId = msg.platformMessageId == null ? null : String(msg.platformMessageId);
  const media = Array.isArray(msg.media) ? msg.media : [];
  return {
    platform,
    bindingId,
    chatKey: String(msg.chatKey ?? ""),
    // "group" | "single" | null when the platform does not say. chatKey alone
    // cannot answer "room or one person?" — the platform uses different APIs for
    // the two, so a consumer that has to guess gets it wrong half the time.
    chatType: msg.chatType ?? null,
    senderId: msg.senderId == null ? null : String(msg.senderId),
    senderName: msg.senderName == null ? null : String(msg.senderName),
    text: String(msg.text ?? ""),
    media: media.map((item, index) => ({
      kind: item.kind,
      url: platformMessageId
        ? tickets.issueFor({
            bindingId,
            platformMessageId,
            index,
            kind: item.kind,
            mime: item.mime ?? null,
          })
        : null,
      mime: item.mime ?? null,
      bytes: item.bytes ?? null,
    })),
    // Carried through verbatim when the platform payload has one. NEVER guessed:
    // a fabricated id would make an unrelated message look like a duplicate.
    platformMessageId,
    receivedAt: msg.receivedAt ?? Date.now(),
    raw: msg.raw ?? null,
  };
}

export function createTickets(cfg) {
  return createMediaTickets({ secret: cfg.mediaSecret, ttlMs: cfg.mediaTtlMs, publicBaseUrl: cfg.publicBaseUrl });
}