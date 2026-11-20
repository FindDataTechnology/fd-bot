// 飞书 / Lark custom-app adapter — ported from paas `server/bots/feishu.js`.
//
// Verification order matters: signature first (when encrypt_key is set), then
// decrypt, then dispatch. The URL-verification handshake arrives on the same
// endpoint as real events, encrypted the same way, so it is handled after
// decrypt.
//
// Crypto: Feishu's encrypt_key scheme is AES-256-CBC with key = sha256(
// encrypt_key) and the IV as the first 16 bytes of the base64-decoded payload —
// NOT GCM. (The original change's design.md said GCM; the official spec is CBC
// and wins. That correction is why this file is a port, not a rewrite.)
//
// Non-text messages are IGNORED here for now. That is a known gap, not an
// oversight: the legacy paas path silently dropped them too, and the media
// face needs a Feishu-specific download+decrypt that is deliberately deferred
// (tasks.md 7.1). The difference is that the SEND side now has an outbound path
// declared and the inbound side says so honestly in comments rather than
// pretending.
import crypto from "node:crypto";
import { fetchWithTimeout, PLATFORM_TIMEOUT_MS } from "../lib/http.js";
import { tokenCache } from "../lib/token-cache.js";

const BASE = process.env.FEISHU_BASE_URL || "https://open.feishu.cn";

const tokens = new Map(); // appId → tokenCache

function tokenFor(cred, fetchImpl) {
  let cache = tokens.get(cred.appId);
  if (!cache) {
    cache = tokenCache(async () => {
      const res = await fetchWithTimeout(
        `${BASE}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ app_id: cred.appId, app_secret: cred.appSecret }),
        },
        { fetchImpl, timeoutMs: PLATFORM_TIMEOUT_MS },
      );
      const j = await res.json().catch(() => ({}));
      if (j.code !== 0) throw new Error(`tenant_access_token: ${j.msg}`);
      return { token: j.tenant_access_token, expiresInSec: j.expire };
    });
    tokens.set(cred.appId, cache);
  }
  return cache;
}

export function decrypt(encryptKey, b64) {
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const buf = Buffer.from(b64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString("utf8");
}

export function checkSignature(headers, raw, encryptKey) {
  const ts = headers["x-lark-request-timestamp"];
  const nonce = headers["x-lark-request-nonce"];
  const sig = headers["x-lark-signature"];
  if (!ts || !nonce || !sig) throw new Error("missing signature headers");
  const expected = crypto.createHash("sha256").update(ts + nonce + encryptKey + raw).digest("hex");
  // Length-guarded timingSafeEqual: unequal lengths throw rather than compare.
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("bad signature");
}

function payloadOf(raw, credentials) {
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("unreadable payload");
  }
  if (!credentials.encryptKey) return body;
  if (typeof body.encrypt !== "string") throw new Error("expected encrypted payload");
  return JSON.parse(decrypt(credentials.encryptKey, body.encrypt));
}

/**
 * One event payload → our message shape. Shared by the callback parser and the
 * long-connection handler so the two legs cannot drift: the platform sends the
 * SAME payload on both, one encrypted, one not.
 */
export function messageFromEvent(payload) {
  if (payload?.header?.event_type !== "im.message.receive_v1") return null;
  const msg = payload.event?.message;
  if (msg?.message_type !== "text") return null;
  let text = "";
  try {
    text = JSON.parse(msg.content).text || "";
  } catch {
    return null;
  }
  if (!text) return null;
  return {
    chatKey: msg.chat_id,
    senderId: payload.event?.sender?.sender_id?.open_id ?? null,
    senderName: payload.event?.sender?.sender_id?.open_id || "unknown",
    text,
    media: [],
    platformMessageId: msg.message_id || null,
  };
}

/** Callback body → handshake echo | message | null. Throws to refuse. */
export function parseCallback({ raw, headers, credentials }) {
  if (credentials.encryptKey) checkSignature(headers, raw, credentials.encryptKey);
  const payload = payloadOf(raw, credentials);
  if (credentials.verificationToken) {
    const token = payload.token ?? payload.header?.token;
    if (token !== credentials.verificationToken) throw new Error("verification token mismatch");
  }
  // URL-verification handshake: echo the challenge verbatim.
  if (payload.type === "url_verification") return { handshake: JSON.stringify({ challenge: payload.challenge }) };
  return { message: messageFromEvent(payload) };
}

export function createTransport(binding, { fetchImpl = null, createWsClient = null } = {}) {
  const cred = binding.credentials;
  let ws = null;
  return {
    inboundMode: binding.inboundMode === "long-connection" ? "long-connection" : "callback",

    async start(onMessage) {
      if (binding.inboundMode !== "long-connection") return;
      // Long connection: we dial the platform, so the binding needs no public
      // address. Two platform facts that shape the handler:
      //   • auth happens once at connect; pushed events are PLAINTEXT — the
      //     signature/decrypt path above does not run on this leg;
      //   • the platform re-pushes if we do not settle within 3s, so the handler
      //     must only hand the message over (fd-bot persists before acking).
      const sdk = await import("@larksuiteoapi/node-sdk");
      const Lark = sdk.default ?? sdk;
      const make =
        createWsClient ??
        ((cfg) => new Lark.WSClient({ ...cfg, loggerLevel: Lark.LoggerLevel?.warn ?? 2 }));
      ws = make({ appId: cred.appId, appSecret: cred.appSecret });
      const dispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          const msg = messageFromEvent(data);
          if (msg) await onMessage(msg);
        },
      });
      ws.start({ eventDispatcher: dispatcher });
    },

    async stop() {
      // The SDK exposes no stop(); dropping the reference is all a caller can do.
      ws = null;
    },

    async sendText(chatKey, text) {
      const send = async () => {
        const res = await fetchWithTimeout(
          `${BASE}/open-apis/im/v1/messages?receive_id_type=chat_id`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${await tokenFor(cred, fetchImpl).get()}`,
            },
            body: JSON.stringify({ receive_id: chatKey, msg_type: "text", content: JSON.stringify({ text }) }),
          },
          { fetchImpl, timeoutMs: PLATFORM_TIMEOUT_MS },
        );
        return res.json().catch(() => ({}));
      };
      let body = await send();
      // A revoked/expired token surfaces as a BODY code, not an HTTP status.
      if (body.code === 99991663 || body.code === 99991661) {
        tokenFor(cred, fetchImpl).invalidate();
        body = await send();
      }
      if (body.code !== 0) throw new Error(`feishu send failed: ${body.code} ${body.msg}`);
    },
  };
}

export default {
  platform: "feishu",
  // tenant_access_token in the body, no caller-IP allowlist — same shape as
  // telegram: this leg survives an egress change.
  outbound: { mode: "url-keyed", inbound: true },
  inboundModes: ["long-connection", "callback"],
  credentialFields: [
    { key: "appId", label: "App ID" },
    { key: "appSecret", label: "App Secret", secret: true },
    { key: "encryptKey", label: "Encrypt Key", required: false, secret: true },
    { key: "verificationToken", label: "Verification Token", required: false, secret: true },
  ],
  createTransport,
  parseCallback,
};
