// 企业微信群机器人 Webhook — OUTBOUND ONLY. Ported from paas
// `server/bots/wecom-webhook.js`.
//
// Why this adapter exists at all: every other WeCom leg is crippled on outbound
// in a way the operator cannot see until answers vanish.
//   wecom (self-built app)  message/send  → gated by 企业可信IP; an egress change
//                                           breaks it (11-18: 19 undelivered
//                                           answers, 60020)
//   wecom-bot (intelligent) response_url  → only inside the window a recent
//                                           inbound opened
// The group robot is the one WeCom surface whose credential IS the URL. It has no
// caller-IP allowlist, so it keeps working from any egress — and NO inbound
// callback at all, which is why `inbound:false` here is load-bearing.
//
// A pure push-only leg is the one honest case where `outbound.mode` may be
// non-none while `inbound` is false; the capability gate allows exactly this.
import { fetchWithTimeout } from "../lib/http.js";

// The only accepted shape is the official endpoint with a key parameter. Accepting
// an arbitrary URL would let a binding row exfiltrate room content to any host —
// and the key IS the credential, so a mistake here is a credential leak, not a typo.
const WEBHOOK_RE = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]{8,128}$/;

export function isValidWebhookUrl(value) {
  return WEBHOOK_RE.test(String(value ?? "").trim());
}

/** A display-safe fingerprint: the key's last 4 chars, never the whole key. */
export function webhookFingerprint(value) {
  const m = /key=([A-Za-z0-9-]+)$/.exec(String(value ?? "").trim());
  return m ? `…${m[1].slice(-4)}` : null;
}

export function createTransport(binding, { fetchImpl = null } = {}) {
  const cred = binding.credentials;
  return {
    inboundMode: "none",
    async start() {},
    async stop() {},
    // A group robot has no notion of a chat: the URL already names the group, so
    // chatKey is not used to address (it is accepted for the shared signature).
    async sendText(_chatKey, text) {
      const url = String(cred?.groupWebhookUrl ?? "").trim();
      if (!isValidWebhookUrl(url)) {
        throw new Error("wecom-webhook: groupWebhookUrl is not a valid group-robot webhook");
      }
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ msgtype: "markdown", markdown: { content: String(text ?? "") } }),
        },
        { fetchImpl, timeoutMs: 10_000 },
      );
      const j = await res.json().catch(() => ({}));
      // 45009 = the robot's per-group rate limit; surfaced verbatim so the room can
      // distinguish throttling from a dead key (93000).
      if (!res.ok || (j.errcode && j.errcode !== 0)) {
        throw new Error(`wecom-webhook send failed: ${res.status} ${j.errcode ?? ""} ${j.errmsg ?? ""}`.trim());
      }
    },
  };
}

export default {
  platform: "wecom-webhook",
  // `inbound:false` ⇒ no callback route is ever registered for this platform,
  // so the absence of an inbound path is structural, not a convention.
  outbound: { mode: "url-keyed", inbound: false },
  inboundModes: [],
  credentialFields: [
    {
      key: "groupWebhookUrl",
      label: "群机器人 Webhook 地址（含 key）",
      secret: true,
      validate: (v) =>
        isValidWebhookUrl(v) ? null : "Webhook 地址必须是 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=… 形式",
    },
  ],
  createTransport,
  // No inbound path by construction. These throw rather than return a benign
  // value: if a caller ever reaches them the routing is wrong, and a silent null
  // would hide that.
  parseCallback() {
    throw new Error("wecom-webhook has no inbound path");
  },
};
