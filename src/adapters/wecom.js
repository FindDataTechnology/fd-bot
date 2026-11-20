// 企业微信 (WeCom) self-built-app adapter — ported from paas `server/bots/wecom.js`.
//
// Both the echo-verify handshake (GET) and real messages (POST) carry a
// msg_signature over sorted(token, timestamp, nonce, ciphertext); the payload
// itself is AES-256-CBC under the EncodingAESKey. Nothing is parsed before both
// checks pass.
//
// WeChat's AES envelope: key = base64(EncodingAESKey + "="), IV = key[0:16],
// plaintext = random(16) || msgLen(uint32 BE) || msg || receiveId, padded PKCS#7
// to a 32-BYTE block (not 16 — hence setAutoPadding(false) + the manual strip).
// Getting that 32 wrong is the classic way this integration produces garbage.
//
// This leg has NO long-connection alternative; it is a straight port.
import crypto from "node:crypto";
import { fetchWithTimeout, PLATFORM_TIMEOUT_MS } from "../lib/http.js";
import { tokenCache } from "../lib/token-cache.js";
import { xmlField } from "../lib/xml.js";

const BASE = process.env.WECOM_BASE_URL || "https://qyapi.weixin.qq.com";

// Two recipients, two APIs — sending a group id to the wrong one is the 81013
// production failure (2026-11-19: `user & party & tag all invalid`). A WeCom
// app-chat id starts `wr`; everything else is a member id.
//
// The rule is DATA in paas (im-lanes.json, operator-editable). Here it is a
// constant with an env override, because fd-bot has no lane-config layer: the
// thing being configured there is group COPY and TIMEOUTS, which stay in paas.
const GROUP_PATTERN = new RegExp(process.env.WECOM_GROUP_PATTERN || "^wr[A-Za-z0-9_-]{8,}$");

function aesKey(encodingAesKey) {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("EncodingAESKey must decode to 32 bytes");
  return key;
}

export function decrypt(encodingAesKey, b64) {
  const key = aesKey(encodingAesKey);
  const d = crypto.createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  d.setAutoPadding(false);
  const buf = Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]);
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) throw new Error("bad padding");
  const body = buf.subarray(16, buf.length - pad);
  const len = body.readUInt32BE(0);
  return { message: body.subarray(4, 4 + len).toString("utf8"), receiveId: body.subarray(4 + len).toString("utf8") };
}

export function encrypt(encodingAesKey, message, receiveId) {
  const key = aesKey(encodingAesKey);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(Buffer.byteLength(message));
  const body = Buffer.concat([crypto.randomBytes(16), len, Buffer.from(message), Buffer.from(receiveId)]);
  const pad = 32 - (body.length % 32);
  const c = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.concat([body, Buffer.alloc(pad, pad)])), c.final()]).toString("base64");
}

export function signature(token, timestamp, nonce, ciphertext) {
  return crypto.createHash("sha1").update([token, timestamp, nonce, ciphertext].sort().join("")).digest("hex");
}

function checkSignature(cred, query, ciphertext) {
  const expected = signature(cred.token, query.timestamp, query.nonce, ciphertext);
  if (query.msg_signature !== expected) throw new Error("bad msg_signature");
}

// One token cache per (corpId, agentId). The credential is read through the
// holder at fetch time, not captured in the closure: a credential rotation
// replaces the binding, and a captured secret would keep fetching with the OLD
// one forever (observed in prod as 40001 after a rotation despite a working
// direct gettoken with the same values).
const tokens = new Map();
function tokenFor(cred, fetchImpl) {
  const k = `${cred.corpId}:${cred.agentId}`;
  let entry = tokens.get(k);
  if (!entry) {
    entry = { cred, cache: null };
    entry.cache = tokenCache(async () => {
      const url = `${BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(entry.cred.corpId)}&corpsecret=${encodeURIComponent(entry.cred.corpSecret)}`;
      const res = await fetchWithTimeout(url, {}, { fetchImpl, timeoutMs: PLATFORM_TIMEOUT_MS });
      const j = await res.json();
      if (j.errcode) throw new Error(`gettoken: ${j.errcode} ${j.errmsg}`);
      return { token: j.access_token, expiresInSec: j.expires_in };
    });
    tokens.set(k, entry);
  }
  entry.cred = cred; // the latest credentials always win
  return entry.cache;
}

export const ENCODING_AES_KEY_FIELD = { key: "encodingAesKey", label: "EncodingAESKey", secret: true };

/** Callback (GET handshake or POST message) → handshake echo | message | null. */
export function parseCallback({ raw, query, method = "POST", credentials }) {
  // GET = the one-time URL echo-verify; the plaintext echostr is the reply.
  if (method === "GET") {
    const echostr = query?.echostr;
    if (!echostr) throw new Error("missing echostr");
    checkSignature(credentials, query, echostr);
    return { handshake: decrypt(credentials.encodingAesKey, echostr).message };
  }
  const encrypted = xmlField(raw?.toString("utf8"), "Encrypt");
  if (!encrypted) throw new Error("missing Encrypt element");
  checkSignature(credentials, query, encrypted);
  const { message } = decrypt(credentials.encodingAesKey, encrypted);
  // 事件回调（`MsgType=event`）走 parseEvent 的上层，不是消息路径。这里只认文本，
  // 其余如实交出 null —— 上层据此决定是否消费（会话存档的同意变更就是这样一条）。
  if (xmlField(message, "MsgType") !== "text") return { message: null, eventXml: message };
  const text = xmlField(message, "Content");
  const from = xmlField(message, "FromUserName");
  if (!text || !from) return { message: null };
  return {
    message: {
      chatKey: from,
      senderId: from,
      senderName: from,
      text,
      media: [],
      platformMessageId: xmlField(message, "MsgId") || null,
    },
  };
}

export function createTransport(binding, { fetchImpl = null } = {}) {
  const cred = binding.credentials;
  return {
    inboundMode: "callback",
    async start() {},
    async stop() {},
    async sendText(chatKey, text) {
      const isGroup = GROUP_PATTERN.test(String(chatKey ?? ""));
      const send = async () => {
        const token = await tokenFor(cred, fetchImpl).get();
        const url = `${BASE}/${isGroup ? "cgi-bin/appchat/send" : "cgi-bin/message/send"}?access_token=${token}`;
        const body = isGroup
          ? { chatid: chatKey, msgtype: "text", text: { content: text }, safe: 0 }
          : { touser: chatKey, msgtype: "text", agentid: Number(cred.agentId), text: { content: text } };
        const res = await fetchWithTimeout(
          url,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
          { fetchImpl, timeoutMs: PLATFORM_TIMEOUT_MS },
        );
        return res.json();
      };
      let j = await send();
      if (j.errcode === 40014 || j.errcode === 42001) {
        // invalid/expired access_token
        tokenFor(cred, fetchImpl).invalidate();
        j = await send();
      }
      if (j.errcode) throw new Error(`wecom send failed: ${j.errcode} ${j.errmsg}`);
    },
  };
}

export default {
  platform: "wecom",
  // `message/send` is a business API under 企业可信IP. 2026-11-18 production: the
  // egress moved and every send failed with 60020 while gettoken kept working —
  // which is why "has credentials" never implies "can send".
  outbound: { mode: "proactive-ip-gated", inbound: true },
  inboundModes: ["callback"],
  credentialFields: [
    { key: "corpId", label: "CorpID" },
    { key: "corpSecret", label: "App Secret", secret: true },
    { key: "agentId", label: "AgentId" },
    { key: "token", label: "Callback Token", secret: true },
    ENCODING_AES_KEY_FIELD,
  ],
  createTransport,
  parseCallback,
};
