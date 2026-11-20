// Slack adapter — ported from paas `server/bots/slack.js`.
//
// Three platform facts shape this file (all carried over, because each one was
// learned the hard way):
//   1. Every request is signed: `X-Slack-Signature` = "v0=" + HMAC-SHA256(
//      signing_secret, "v0:{timestamp}:{raw body}"). The raw bytes must be the
//      ones Slack sent, so the callback route hands us the unparsed body.
//   2. The timestamp is checked against a 5-minute window; outside it the
//      request is a replay and is refused.
//   3. `url_verification` arrives on the same endpoint as real events and wants
//      its challenge echoed.
//
// chatKey carries the THREAD when there is one (`C123:1673464730.703009`) and
// the bare channel otherwise: a Slack thread is where a group actually talks
// about one thing. Colon never appears in a channel id or a ts, so the first
// colon is an unambiguous split.
import crypto from "node:crypto";
import { fetchWithTimeout, PLATFORM_TIMEOUT_MS } from "../lib/http.js";

const API = "https://slack.com/api";
const MAX_SKEW_SEC = 5 * 60;

// The ONE subtype that carries a real person's text we want. Everything else
// (message_changed/deleted/join/leave/bot_message/...) is noise: edits would
// double-post, bot echoes would loop. `file_share` is absent on purpose —
// Slack stopped dispatching it (file shares arrive as a plain message carrying
// `files`), so listing it would be dead code pretending to handle a case it
// cannot see.
const KEPT_SUBTYPES = new Set(["thread_broadcast"]);

export function splitChatKey(chatKey) {
  const s = String(chatKey ?? "");
  const i = s.indexOf(":");
  return i === -1 ? { channel: s, threadTs: null } : { channel: s.slice(0, i), threadTs: s.slice(i + 1) || null };
}

export function verifySignature({ raw, headers, credentials }, now = Date.now()) {
  const ts = headers["x-slack-request-timestamp"];
  const sig = headers["x-slack-signature"];
  if (!ts || !sig) throw new Error("missing signature headers");
  const skew = Math.abs(now / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_SEC) throw new Error("stale request timestamp");
  const expected = `v0=${crypto.createHmac("sha256", credentials.signingSecret).update(`v0:${ts}:${raw}`).digest("hex")}`;
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("bad signature");
}

/** Callback body → handshake echo | message | null. */
export function parseCallback({ raw, headers, credentials }) {
  verifySignature({ raw, headers, credentials });
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("unreadable payload");
  }
  if (body.type === "url_verification") return { handshake: JSON.stringify({ challenge: body.challenge ?? "" }) };
  if (body.type !== "event_callback") return { message: null };
  const ev = body.event;
  if (!ev || ev.type !== "message") return { message: null };
  // Our own (and any other bot's) messages must never re-enter the room.
  if (ev.bot_id || ev.subtype === "bot_message") return { message: null };
  if (ev.subtype && !KEPT_SUBTYPES.has(ev.subtype)) return { message: null };
  const text = typeof ev.text === "string" ? ev.text.trim() : "";
  if (!text || !ev.channel) return { message: null };
  // thread_broadcast reports the ROOT ts in `ts`; the reply's own ts is the one
  // that identifies this message (`event_ts` is the canonical carrier).
  const ts = ev.event_ts || ev.ts || null;
  const threadRoot = ev.thread_ts ?? null;
  return {
    message: {
      chatKey: threadRoot ? `${ev.channel}:${threadRoot}` : ev.channel,
      senderId: ev.user ?? null,
      senderName: ev.user || ev.username || "unknown",
      text,
      media: [],
      platformMessageId: ts ? `${ev.channel}:${ts}` : null,
    },
  };
}

export function createTransport(binding, { fetchImpl = null } = {}) {
  const cred = binding.credentials;
  return {
    inboundMode: "callback", // Slack pushes; there is no long connection to dial
    async start() {},
    async stop() {},
    async sendText(chatKey, text) {
      const { channel, threadTs } = splitChatKey(chatKey);
      const payload = { channel, text };
      if (threadTs) payload.thread_ts = threadTs;
      const res = await fetchWithTimeout(
        `${API}/chat.postMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cred.botToken}` },
          body: JSON.stringify(payload),
        },
        { fetchImpl, timeoutMs: PLATFORM_TIMEOUT_MS },
      );
      const json = await res.json().catch(() => ({}));
      // Slack answers 200 with {ok:false, error} for EVERY failure mode,
      // including a revoked token — the body is the only signal.
      if (!json.ok) throw new Error(`slack send failed: ${json.error ?? "unknown_error"}`);
    },
  };
}

export default {
  platform: "slack",
  // The bot token rides an Authorization header and Slack applies no caller-IP
  // allowlist — this leg keeps delivering when our egress address changes (the
  // exact failure that broke the WeCom self-built app in production on 11-18).
  //
  // Declared HERE, next to the code that sends, because that is the whole point:
  // `add-mattermost-channel` found Slack one day behind the capability contract
  // with NO declaration, so `outboundCapabilityFor("slack")` said `none` and the
  // binding panel called a working bot undeliverable.
  outbound: { mode: "url-keyed", inbound: true },
  inboundModes: ["callback"],
  credentialFields: [
    { key: "botToken", label: "Bot User OAuth Token (xoxb-…)", secret: true },
    { key: "signingSecret", label: "Signing Secret", secret: true },
  ],
  createTransport,
  parseCallback,
};
