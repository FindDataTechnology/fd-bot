// 企业微信「智能机器人」— long-connection transport.
//
// Replaces the HTTP-callback + response_url implementation that lived in the paas
// cell. Two structural arguments for the long connection, both measured there:
//   • the HTTP callback needs a PUBLIC-BASE-URL that the platform can reach;
//   • the passive reply window (`response_url`, ~1h, one call per URL) forced a
//     SQLite table whose loss meant "the next answer cannot be delivered at all"
//     (comment in the old adapter: "measured repeatedly on 2026-11-19").
// A WebSocket we dial ourselves has neither problem: no inbound reachability, no
// per-message reply URL, and `sendMessage(chatid)` sends unprompted.
//
// Capability is declared CONSERVATIVELY: `proactive-ip-gated` until
// `adopt-fd-bot-transport` task 5.2 proves on a real egress that the platform
// does not apply its trusted-IP allowlist to this channel. Declaring
// `url-keyed` before that evidence exists would be the same class of lie that
// `add-mattermost-channel` found in Slack's missing declaration.
import AiBot from "@wecom/aibot-node-sdk";

// Media descriptors (url + per-file aeskey) arrive with the message and are
// valid for minutes. The envelope carries a signed ticket instead of bytes, so
// this cache is what a later ticket redemption reads. Bounded by TTL, and the
// ticket TTL is the same order of magnitude on purpose.
const MEDIA_TTL_MS = 5 * 60_000;

const chatKeyOf = (body) => {
  if (String(body.chattype).toLowerCase() === "group") return body.chatid ?? null;
  return body.from?.userid ?? body.from?.userId ?? null;
};

const senderOf = (body) => body.from?.userid ?? body.from?.userId ?? null;

/** Flatten one platform message into our text + media lists. */
function flatten(body) {
  const media = [];
  let text = "";
  const t = body.msgtype;
  if (t === "text" || t === "mixed") {
    text = body.text?.content ?? body.mixed?.text?.content ?? "";
  } else if (t === "voice") {
    // Speech-to-text is supplied by the platform for this message type.
    text = body.voice?.content ?? "";
  }
  if (t === "image" && body.image?.url) {
    media.push({ kind: "image", url: body.image.url, aeskey: body.image.aeskey ?? null, mime: null });
  } else if (t === "file" && body.file?.url) {
    media.push({ kind: "file", url: body.file.url, aeskey: body.file.aeskey ?? null, mime: null });
  } else if (t === "video" && body.video?.url) {
    media.push({ kind: "video", url: body.video.url, aeskey: body.video.aeskey ?? null, mime: null });
  }
  // mixed carries interleaved items; the text half is above, images ride along.
  for (const item of body.mixed?.msg_item ?? []) {
    if (item.msgtype === "image" && item.image?.url) {
      media.push({ kind: "image", url: item.image.url, aeskey: item.image.aeskey ?? null, mime: null });
    }
  }
  return { text, media };
}

export function createTransport(binding, { createClient = (opts) => new AiBot.WSClient(opts) } = {}) {
  const { botId, secret } = binding.credentials;
  const mediaCache = new Map(); // platformMessageId -> { at, items:[{kind,url,aeskey,mime}] }
  let client = null;

  function rememberMedia(id, items) {
    if (!id) return;
    const now = Date.now();
    for (const [k, v] of mediaCache) if (now - v.at > MEDIA_TTL_MS) mediaCache.delete(k);
    mediaCache.set(id, { at: now, items });
  }

  return {
    inboundMode: "long-connection",
    // 本 transport 会自己上报连接状态；connections.js 据此不再假定「start 返回 = 连上了」。
    reportsState: true,

    async start(onMessage, onStateChange) {
      if (!botId || !secret) throw new Error("wecom-bot transport needs botId and secret");
      client = createClient({
        botId,
        secret,
        // Reconnect forever: a platform outage is not a reason to give up and
        // require an operator to restart the pod.
        maxReconnectAttempts: -1,
        maxAuthFailureAttempts: 5,
      });
      client.on("message", (frame) => {
        const body = frame?.body;
        if (!body) return;
        const { text, media } = flatten(body);
        const id = body.msgid ?? null;
        if (media.length) rememberMedia(id, media);
        // One message in → one envelope out.
        //
        // `chatType` is carried explicitly (2026-11-20, found on a real inbound):
        // a group message arrives with `chattype:"group"` + `chatid`, a direct
        // message with `chattype:"single"` + no chatid, and BOTH reduce to a bare
        // string in chatKey. Without this field a consumer cannot tell whether it
        // is answering a room or one person — and "reply to the group" and "reply
        // to a member" are different platform APIs.
        void onMessage({
          chatKey: chatKeyOf(body),
          chatType: String(body.chattype ?? "").toLowerCase() || null,
          senderId: senderOf(body),
          senderName: senderOf(body),
          text,
          media: media.map((m) => ({ kind: m.kind, mime: m.mime, bytes: null })),
          platformMessageId: id,
          raw: null,
        });
      });
      // Real connection state, from the SDK's own events. Without this the
      // binding reports connected:true the instant start() returns — which is a
      // LIE when authentication then fails (measured 2026-11-21: errcode 846601
      // "websocket mode not enabled", while /v1/bindings said connected:true).
      client.on("authenticated", () => onStateChange?.({ connected: true, error: null }));
      client.on("disconnected", (reason) =>
        onStateChange?.({ connected: false, error: `disconnected: ${reason}` }),
      );
      client.on("error", (err) => {
        const msg = String(err?.message ?? err);
        // Auth failure is terminal for this binding, not a transient blip.
        if (/Authentication failed/i.test(msg)) onStateChange?.({ connected: false, error: msg.slice(0, 200) });
        console.warn(`[wecom-bot] socket error: ${msg}`);
      });
      client.connect();
    },

    async stop() {
      try {
        client?.disconnect();
      } finally {
        client = null;
        mediaCache.clear();
      }
    },

    async sendText(chatKey, text) {
      if (!client) throw new Error("wecom-bot transport not started");
      // Markdown is the only shape this platform renders for bot messages with
      // any formatting; plain text arrives wrapped and unreadable in a group.
      await client.sendMessage(chatKey, { msgtype: "markdown", markdown: { content: text } });
    },

    /**
     * Resolve one media item named by a signed ticket. The cache holds the
     * platform's short-lived URL + per-file aeskey; the SDK does the AES decrypt.
     */
    async downloadMedia({ platformMessageId, index }) {
      const entry = mediaCache.get(platformMessageId);
      if (!entry) return null; // expired — the platform also expires these
      const item = entry.items[index];
      if (!item) return null;
      if (!client) throw new Error("wecom-bot transport not started");
      const { buffer, filename } = await client.downloadFile(item.url, item.aeskey ?? undefined);
      return { buffer, mime: item.mime ?? guessMime(filename), filename };
    },
  };
}

function guessMime(name = "") {
  const ext = String(name).toLowerCase().split(".").pop();
  return (
    { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", pdf: "application/pdf" }[ext] ??
    "application/octet-stream"
  );
}

export default {
  platform: "wecom-bot",
  // MEASURED (2026-11-20, task 5.2), not assumed. Over the long connection,
  // `sendMessage(chatid)` delivered with no prior inbound on two different
  // groups: errcode 0 in 360ms and 308ms. The old HTTP-callback leg could only
  // reply inside a ~1h passive window and was gated by 企业可信IP; the long
  // connection has neither constraint, because WE dial the platform — there is
  // no caller address for the platform to allowlist.
  //
  // Consequence worth stating plainly: this is the FIRST WeCom leg that is
  // genuinely url-keyed. An egress change cannot break it.
  outbound: { mode: "url-keyed", inbound: true },
  inboundModes: ["long-connection"],
  credentialFields: [
    { key: "botId", label: "Bot ID" },
    { key: "secret", label: "Secret", secret: true },
  ],
  createTransport,
};
