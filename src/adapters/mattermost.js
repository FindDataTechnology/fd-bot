// Mattermost adapter — ported from paas `server/bots/mattermost.js`.
//
// ONE bot token both receives and sends, and Mattermost applies no caller-IP
// allowlist in either direction — the combination none of the WeCom legs have.
//
// Two inbound shapes, chosen per binding, never both at once:
//   callback   the instance POSTs us at our public address (outgoing webhook),
//              carrying its per-webhook `token`; the token IS the authentication.
//   subscribe  we dial wss://<site>/api/v4/websocket and receive a push stream.
//              Needs no public address.
//
// The callback path never answers inline: Mattermost's outgoing-integration
// timeout is 30s and a room turn runs for minutes, so returning `{"text": …}` is
// a guaranteed timeout. We acknowledge immediately and deliver with
// POST /api/v4/posts, deriving chatKey from the triggering post so answers still
// land in the right conversation.
//
// Docs: https://developers.mattermost.com/integrate/reference/personal-access-token/
//       https://developers.mattermost.com/integrate/webhooks/outgoing/
import crypto from "node:crypto";
import { fetchWithTimeout, PLATFORM_TIMEOUT_MS } from "../lib/http.js";

const BODY_EXCERPT = 200;

// Trailing slash trimmed so `${site}/api/v4/...` never doubles it.
const siteOf = (cred) => String(cred?.siteUrl ?? "").trim().replace(/\/+$/, "");

/** `channel[:rootPostId]` → the two fields POST /api/v4/posts needs. */
export function splitChatKey(chatKey) {
  const s = String(chatKey ?? "");
  const i = s.indexOf(":");
  return i === -1 ? { channelId: s, rootId: null } : { channelId: s.slice(0, i), rootId: s.slice(i + 1) || null };
}

/** Constant-time compare of the instance-issued webhook token. */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  if (!b.length) return false; // unconfigured never authorizes
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The channels this bot is allowed to act in.
 *
 * Fail-closed: an outgoing webhook is configured per channel and fires for
 * messages the bot never sees, so membership is NOT a boundary on this shape. An
 * empty list means "no channel", never "all channels".
 */
export function allowedChannelsOf(cred) {
  const raw = cred?.allowedChannels;
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,]+/);
  return new Set(list.map((x) => String(x).trim()).filter(Boolean));
}

function safeParse(json) {
  if (typeof json !== "string") return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** One websocket `posted` event → the canonical inbound message, or null. */
function fromPost(post, ev, cred) {
  const text = typeof post.message === "string" ? post.message.trim() : "";
  if (!text || !post.channel_id) return null;
  // Same fail-closed gate as the callback shape, so "which channels" is a
  // declaration rather than a platform detail.
  if (!allowedChannelsOf(cred).has(String(post.channel_id))) return null;
  // Echo filter: the integration's own posts carry no `user_id` at all, and our
  // bot account's posts must not re-enter the room.
  if (!post.user_id) return null;
  if (cred?.botUserId && post.user_id === cred.botUserId) return null;
  // bot posts always carry `props.from_bot`; a human post never does.
  if (post.props?.from_bot === "true" || post.props?.from_bot === true) return null;
  const rootId = post.root_id || null;
  const conversationId = rootId || post.id || null;
  return {
    chatKey: conversationId ? `${post.channel_id}:${conversationId}` : String(post.channel_id),
    senderId: post.user_id ?? null,
    senderName: ev.data?.sender_name || post.user_id || "unknown",
    text,
    media: [],
    platformMessageId: post.id ? `${post.channel_id}:${post.id}` : null,
  };
}

/** Callback body → message | null. Throws to refuse (the route answers 403). */
export function parseCallback({ raw, credentials }) {
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("unreadable payload");
  }
  // Nothing below runs on an unauthenticated body. Mattermost has no signature
  // scheme for outgoing webhooks — the shared `token` field IS the
  // authentication, and an unconfigured webhookToken never authorizes.
  if (!tokenMatches(body?.token, credentials?.webhookToken)) throw new Error("bad webhook token");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || !body.channel_id) return { message: null };
  if (!allowedChannelsOf(credentials).has(String(body.channel_id))) return { message: null };
  // The integration's own posts carry no user_id — that is the practical echo
  // signal, and it is why a missing user_id returns null rather than a guess.
  if (!body.user_id) return { message: null };
  if (credentials?.botUserId && body.user_id === credentials.botUserId) return { message: null };
  // Thread key: a reply inside a thread lands in the same conversation as the
  // post that opened it (threaded replies carry root_id; a root post has none).
  const rootId = body.root_id || null;
  const conversationId = rootId || body.post_id || null;
  return {
    message: {
      chatKey: conversationId ? `${body.channel_id}:${conversationId}` : String(body.channel_id),
      senderId: body.user_id ?? null,
      senderName: body.user_name || body.user_id || "unknown",
      text,
      media: [],
      platformMessageId: body.post_id ? `${body.channel_id}:${body.post_id}` : null,
    },
  };
}

export function createTransport(binding, { fetchImpl = null } = {}) {
  const cred = binding.credentials;
  const inboundMode = binding.inboundMode === "callback" ? "callback" : "subscribe";
  let stopSocket = null;

  return {
    inboundMode,
    // Only the subscribe leg owns a socket whose state can lie; a callback leg
    // is reachable through the route, which connections.js already treats as
    // connected.
    reportsState: inboundMode !== "callback",

    async start(onMessage, onStateChange) {
      // Callback mode: the platform calls us; nothing to dial.
      if (inboundMode === "callback") return;
      const site = siteOf(cred);
      const token = String(cred.botToken ?? "").trim();
      if (!site || !token) {
        console.warn(`[mattermost] binding ${binding.id} cannot subscribe: siteUrl/botToken missing`);
        return;
      }
      let stopped = false;
      let ws = null;
      let retryMs = 1000;
      let retryTimer = null;

      const connect = () => {
        if (stopped) return;
        const url = `${site.replace(/^http/, "ws")}/api/v4/websocket`;
        ws = new WebSocket(url);
        ws.addEventListener("open", () => {
          retryMs = 1000; // a successful open resets the backoff
          // Auth frame: the token is the same one sendText uses.
          ws.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token } }));
          onStateChange?.({ connected: true, error: null });
        });
        ws.addEventListener("message", (event) => {
          let ev;
          try {
            ev = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (ev?.event !== "posted") return; // typing/status/presence are noise
          const post = ev.data?.post ? safeParse(ev.data.post) : null;
          if (!post) return;
          const msg = fromPost(post, ev, cred);
          if (msg) void onMessage(msg);
        });
        ws.addEventListener("error", (event) => {
          if (stopped) return;
          const msg = String(event?.message ?? event?.error?.message ?? "socket error");
          onStateChange?.({ connected: false, error: msg.slice(0, 200) });
          console.warn(`[mattermost] subscribe (${binding.id}): ${msg}`);
        });
        ws.addEventListener("close", () => {
          ws = null;
          if (stopped) return;
          onStateChange?.({ connected: false, error: null });
          // Backoff: an instance restart or a network blip both land here.
          retryTimer = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 30_000);
        });
      };
      connect();

      stopSocket = () => {
        stopped = true;
        if (retryTimer) clearTimeout(retryTimer);
        // shortcut: the global WebSocket has no terminate(), only a close
        // handshake — a peer that never answers it holds this socket until the
        // client's own close timeout. Add the `ws` dependency if shutdown ever
        // hangs on that.
        try {
          ws?.close();
        } catch {
          /* already gone */
        }
        ws = null;
      };
    },

    // stop() MUST close the socket: every config change stops then starts, and
    // a leaked socket means one connection per edit.
    async stop() {
      stopSocket?.();
      stopSocket = null;
    },

    async sendText(chatKey, text) {
      const site = siteOf(cred);
      const token = String(cred.botToken ?? "").trim();
      if (!site || !token) throw new Error("mattermost: siteUrl and botToken are required to send");
      const { channelId, rootId } = splitChatKey(chatKey);
      if (!channelId) throw new Error("mattermost: chatKey carries no channel");
      const body = { channel_id: channelId, message: String(text ?? "") };
      if (rootId) body.root_id = rootId;
      const res = await fetchWithTimeout(
        `${site}/api/v4/posts`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        },
        { fetchImpl, timeoutMs: PLATFORM_TIMEOUT_MS },
      );
      // A revoked token or a missing channel must surface as a real error, not a
      // silent no-op.
      if (!res.ok) {
        const excerpt = String(await res.text().catch(() => "")).slice(0, BODY_EXCERPT);
        throw new Error(`mattermost send failed: ${res.status} ${excerpt}`.trim());
      }
    },
  };
}

export default {
  platform: "mattermost",
  // Receives AND sends; the access token rides an Authorization header and
  // Mattermost applies no caller allowlist, so an egress change cannot break it.
  outbound: { mode: "url-keyed", inbound: true },
  inboundModes: ["callback", "subscribe"],
  credentialFields: [
    // The instance root, e.g. https://im.example.com — never a token.
    {
      key: "siteUrl",
      label: "实例地址 (https://…)",
      required: true,
      validate: (v) =>
        /^https?:\/\/[^\s]+$/.test(String(v ?? "").trim()) ? null : "实例地址必须是 http(s):// 开头的完整地址",
    },
    // Bot account token, minted by an admin. A password: masked everywhere.
    { key: "botToken", label: "Bot Access Token", secret: true },
    // Only needed on the callback shape; omitted when the server subscribes.
    { key: "webhookToken", label: "Outgoing Webhook Token（仅回调入站时需要）", required: false, secret: true },
    // Fail-closed: empty means no channel acts, never "all channels".
    {
      key: "allowedChannels",
      label: "参与的频道 ID（逗号分隔，留空则不处理任何频道）",
      required: false,
    },
    { key: "botUserId", label: "Bot 用户 ID（用于过滤自己的发言）", required: false },
    { key: "qrUrl", label: "入口链接 (QR)", required: false },
  ],
  // No QR is minted by Mattermost; the operator pastes the team entry URL.
  qr: { strategy: "manual", field: "qrUrl", hintKey: "botsPage.qr.hint.manual" },
  createTransport,
  parseCallback,
};
