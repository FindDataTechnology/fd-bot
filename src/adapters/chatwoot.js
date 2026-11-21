// Chatwoot adapter — self-hosted support desk (MIT), driven by its Agent Bot
// feature: Chatwoot POSTs webhooks at us and we answer through its REST API.
//
// Two platform facts shape this file:
//   1. Every webhook is signed. `X-Chatwoot-Signature` = "sha256=" + HMAC-SHA256(
//      secret, "{X-Chatwoot-Timestamp}.{raw body}"), with the timestamp in epoch
//      seconds. The parser gets the unparsed body, so the HMAC covers the exact
//      bytes Chatwoot sent. A >5-minute skew is a replay and is refused.
//   2. The webhook stream is the WHOLE conversation history replayed at us: it
//      carries our own `outgoing` replies and agents' `private` notes. Both must
//      be dropped before they re-enter, or the bot answers itself forever.
//
// chatKey is `accountId:conversationId`. The account id is part of the key
// because the reply URL needs it (`/api/v1/accounts/{accountId}/...`), so a
// consumer that round-trips chatKey into sendText needs no other lookup.
//
// Outbound auth (VERIFIED against a live Chatwoot 4.19.0 on 2026-11-21): an
// Agent Bot token authenticates with `Authorization: Bearer <token>`. It is NOT
// `Bot <token>` — that scheme returned 401 on the real instance. Chatwoot's
// AccessTokenAuthHelper accepts only `Bearer` (or the legacy `api_access_token`
// header); a Bot owner is additionally restricted to BOT_ACCESSIBLE_ENDPOINTS,
// which include `conversations/messages#create` and `conversations#toggle_status`.
// If this leg ever 401s with a token known good, the token kind (user vs agent
// bot) or the scheme is the first thing to check.
import crypto from "node:crypto";
import { fetchWithTimeout, PLATFORM_TIMEOUT_MS } from "../lib/http.js";

const MAX_SKEW_SEC = 5 * 60;
const BODY_EXCERPT = 200;

export function splitChatKey(chatKey) {
  const s = String(chatKey ?? "");
  const i = s.indexOf(":");
  return { accountId: s.slice(0, i), conversationId: i === -1 ? "" : s.slice(i + 1) };
}

export function verifySignature({ raw, headers, credentials }, now = Date.now()) {
  if (!credentials.webhookSecret) throw new Error("webhookSecret is required");
  const ts = headers["x-chatwoot-timestamp"];
  const sig = headers["x-chatwoot-signature"];
  if (!ts || !sig) throw new Error("missing signature headers");
  const skew = Math.abs(now / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_SEC) throw new Error("stale request timestamp");
  const expected = `sha256=${crypto.createHmac("sha256", credentials.webhookSecret).update(`${ts}.${raw}`).digest("hex")}`;
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("bad signature");
}

/** Webhook body → message | null. Throws to refuse. */
export function parseCallback({ raw, headers, credentials }) {
  verifySignature({ raw, headers, credentials });
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("unreadable payload");
  }
  // Only a freshly created message is a thing to answer. Status/open/close
  // events describe the desk, not a person speaking.
  if (body.event !== "message_created") return { message: null };
  // The echo-loop guard: our own replies come back as `outgoing`. Never re-enter.
  if (body.message_type !== "incoming") return { message: null };
  // Private notes are agents talking to each other, not to the customer.
  if (body.private === true) return { message: null };
  const text = typeof body.content === "string" ? body.content.trim() : "";
  const accountId = body.account?.id;
  const conversationId = body.conversation?.id;
  if (!text || accountId == null || conversationId == null) return { message: null };

  const meta = body.conversation.meta ?? {};
  const assignee =
    meta.assignee?.id != null
      ? { id: meta.assignee.id, type: meta.assignee_type ?? null }
      : null;

  return {
    message: {
      chatKey: `${String(accountId)}:${String(conversationId)}`,
      senderId: body.sender?.id == null ? null : String(body.sender.id),
      senderName: body.sender?.name || "unknown",
      text,
      media: [],
      platformMessageId: body.id == null ? null : String(body.id),
      // A Chatwoot conversation is one contact and the agents serving them —
      // there is no room/group semantics to distinguish.
      chatType: "single",
      assignee,
      conversationStatus: body.conversation.status ?? null,
    },
  };
}

export function createTransport(binding, { fetchImpl = null } = {}) {
  const cred = binding.credentials;
  const base = String(cred.baseUrl ?? "").replace(/\/+$/, "");
  return {
    inboundMode: "callback", // Chatwoot pushes; there is no long connection to dial
    async start() {},
    async stop() {},
    async sendText(chatKey, text) {
      const { accountId, conversationId } = splitChatKey(chatKey);
      if (!accountId || !conversationId) throw new Error(`chatwoot: bad chatKey "${chatKey}"`);
      const res = await fetchWithTimeout(
        `${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cred.apiToken}` },
          body: JSON.stringify({ content: String(text ?? ""), message_type: "outgoing" }),
        },
        { fetchImpl, timeoutMs: PLATFORM_TIMEOUT_MS },
      );
      if (!res.ok) {
        const excerpt = String(await res.text().catch(() => "")).slice(0, BODY_EXCERPT);
        throw new Error(`chatwoot send failed: ${res.status} ${excerpt}`.trim());
      }
    },
  };
}

export default {
  platform: "chatwoot",
  // The Agent Bot token rides an Authorization header; Chatwoot applies no
  // caller-IP allowlist, so an egress change cannot break this leg.
  outbound: { mode: "url-keyed", inbound: true },
  inboundModes: ["callback"],
  credentialFields: [
    { key: "baseUrl", label: "Chatwoot base URL (https://desk.example.com)" },
    { key: "apiToken", label: "Agent Bot access token", secret: true },
    { key: "accountId", label: "Account id" },
    // Required on purpose: an optional secret is a secret that silently goes
    // unverified, and then anyone who learns the callback URL can inject messages.
    { key: "webhookSecret", label: "Webhook secret", secret: true },
  ],
  createTransport,
  parseCallback,
};
