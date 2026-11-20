// 微信公众号 (WeChat Official Account) adapter — ported from paas
// `server/bots/wechat-oa.js`.
//
// Verification is the classic sha1 over sorted(token, timestamp, nonce); the GET
// handshake echoes `echostr`, POSTs carry a flat plaintext XML message. Replies
// go out as customer-service messages, which WeChat only permits within 48h of
// the user's last message — a send outside that window fails with errcode 45015,
// which the failure classifier maps to reply-window-closed rather than "other".
//
// v1 ceiling (carried over): plaintext callback mode only. 安全模式 (AES) uses the
// same envelope as WeCom — reuse wecom.js's decrypt/signature if it is needed.
import crypto from "node:crypto";
import { fetchWithTimeout } from "../lib/http.js";
import { tokenCache } from "../lib/token-cache.js";
import { xmlField } from "../lib/xml.js";

const BASE = process.env.WECHAT_OA_BASE_URL || "https://api.weixin.qq.com";

function checkSignature(cred, query) {
  const expected = crypto
    .createHash("sha1")
    .update([cred.token, query.timestamp, query.nonce].sort().join(""))
    .digest("hex");
  if (query.signature !== expected) throw new Error("bad signature");
}

const tokens = new Map(); // appId → { cred, cache }
function tokenFor(cred, fetchImpl) {
  let entry = tokens.get(cred.appId);
  if (!entry) {
    entry = { cred, cache: null };
    entry.cache = tokenCache(async () => {
      // Read the cred through the holder, not the closure argument: a credential
      // rotation replaces the binding, and a captured secret would keep fetching
      // with the OLD one forever (the wecom adapter hit exactly this).
      const url = `${BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(entry.cred.appId)}&secret=${encodeURIComponent(entry.cred.appSecret)}`;
      const res = await fetchWithTimeout(url, {}, { fetchImpl, timeoutMs: 10_000 });
      const j = await res.json();
      if (j.errcode) throw new Error(`token: ${j.errcode} ${j.errmsg}`);
      return { token: j.access_token, expiresInSec: j.expires_in };
    });
    tokens.set(cred.appId, entry);
  }
  entry.cred = cred; // the latest credentials always win
  return entry.cache;
}

export function parseCallback({ raw, query, method = "POST", credentials }) {
  checkSignature(credentials, query ?? {});
  // GET = the one-time URL handshake; echo echostr verbatim.
  if (method === "GET") return { handshake: String(query.echostr ?? "") };
  const text = xmlField(raw?.toString("utf8"), "Content");
  const from = xmlField(raw?.toString("utf8"), "FromUserName");
  if (xmlField(raw?.toString("utf8"), "MsgType") !== "text" || !text || !from) return { message: null };
  return {
    message: {
      chatKey: from,
      senderId: from,
      senderName: from,
      text,
      media: [],
      platformMessageId: xmlField(raw?.toString("utf8"), "MsgId") || null,
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
      const send = async () => {
        const url = `${BASE}/cgi-bin/message/custom/send?access_token=${await tokenFor(cred, fetchImpl).get()}`;
        const res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ touser: chatKey, msgtype: "text", text: { content: text } }),
          },
          { fetchImpl, timeoutMs: 10_000 },
        );
        return res.json();
      };
      let j = await send();
      if (j.errcode === 40014 || j.errcode === 42001) {
        tokenFor(cred, fetchImpl).invalidate();
        j = await send();
      }
      if (j.errcode) throw new Error(`wechat-oa send failed: ${j.errcode} ${j.errmsg}`);
    },
  };
}

export default {
  platform: "wechat-oa",
  // The official-account message APIs enforce an IP allowlist exactly like WeCom:
  // an egress change breaks sending while the credentials stay valid. The 48h
  // customer-service window is a second, independent limit.
  outbound: { mode: "proactive-ip-gated", inbound: true },
  inboundModes: ["callback"],
  credentialFields: [
    { key: "appId", label: "AppID" },
    { key: "appSecret", label: "AppSecret", secret: true },
    { key: "token", label: "Callback Token", secret: true },
  ],
  createTransport,
  parseCallback,
};
