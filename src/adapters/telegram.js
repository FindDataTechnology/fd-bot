// Telegram adapter — ported from paas `server/bots/telegram.js`.
//
// Two inbound shapes, chosen per binding:
//   poll      we call getUpdates; needs no public address (the default)
//   callback  the platform POSTs us; needs FD_BOT_PUBLIC_BASE_URL
//
// The wire format and the long-poll discipline are carried over verbatim,
// including the reason the poll loop must ABORT on shutdown rather than just
// setting a flag: a parked getUpdates holds the process open for its full
// window (that cost the paas unit suite a 1h CI hang on 2026-11-09).
import { fetchWithTimeout } from "../lib/http.js";

const API = "https://api.telegram.org";
const POLL_TIMEOUT_SEC = 25;
// Long-poll headroom: getUpdates parks for POLL_TIMEOUT_SEC by design, so its
// deadline must exceed the poll window, not the shared default.
const POLL_TIMEOUT_MS = (POLL_TIMEOUT_SEC + 5) * 1000;
// Same lesson as lib/http: a platform call from a China egress legitimately
// takes >10s. The long-poll window keeps its own (larger) deadline below.
const CALL_TIMEOUT_MS = 30_000;

const api = (token, method) => `${API}/bot${token}/${method}`;

async function call(token, method, body, { timeoutMs = CALL_TIMEOUT_MS, signal, fetchImpl } = {}) {
  const res = await fetchWithTimeout(
    api(token, method),
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) },
    { timeoutMs, fetchImpl },
  );
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const err = new Error(`telegram ${method} failed: ${json.description || res.status}`);
    // A 403/401 from Telegram is a credential problem; surface it as such so the
    // send verdict classifies before any prose matching.
    if (res.status === 401 || res.status === 403) err.failure = "other";
    throw err;
  }
  return json.result;
}

/** Update → our message shape. Non-text updates return null (ignored). */
export function updateToMessage(update) {
  const m = update?.message;
  const text = m?.text;
  if (!m?.chat?.id || !text) return null;
  return {
    chatKey: String(m.chat.id),
    senderId: m.from?.id != null ? String(m.from.id) : null,
    senderName:
      m.from?.username || [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || "unknown",
    text,
    media: [],
    platformMessageId: m.message_id != null ? String(m.message_id) : null,
  };
}

export function createTransport(binding, { fetchImpl = null } = {}) {
  const cred = binding.credentials;
  let stopPoll = null;

  return {
    inboundMode: binding.inboundMode === "callback" ? "callback" : "poll",

    async start(onMessage) {
      // Callback mode: the platform calls us; nothing to dial.
      if (binding.inboundMode === "callback") return;
      let stopped = false;
      let offset = 0;
      let abortPoll = null;
      const loop = async () => {
        while (!stopped) {
          try {
            const controller = new AbortController();
            abortPoll = () => controller.abort();
            const updates = await call(cred.token, "getUpdates",
              { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ["message"] },
              { timeoutMs: POLL_TIMEOUT_MS, signal: controller.signal, fetchImpl });
            for (const u of updates) {
              offset = u.update_id + 1;
              const msg = updateToMessage(u);
              if (msg) void onMessage(msg);
            }
          } catch (err) {
            if (stopped) return;
            console.warn(`[telegram] poll for ${binding.id}: ${err.message}`);
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      };
      void loop();
      stopPoll = () => {
        stopped = true;
        abortPoll?.();
      };
    },

    async stop() {
      stopPoll?.();
      stopPoll = null;
    },

    async sendText(chatKey, text) {
      await call(cred.token, "sendMessage", { chat_id: chatKey, text }, { fetchImpl });
    },
  };
}

/** Callback-mode parser, used by the /v1/callbacks route. */
export function parseCallback({ raw, headers, credentials }) {
  if (credentials.secretToken) {
    const given = headers["x-telegram-bot-api-secret-token"];
    if (given !== credentials.secretToken) throw new Error("secret token mismatch");
  }
  let update;
  try {
    update = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("unreadable update");
  }
  const message = updateToMessage(update);
  return { message }; // null message → acknowledged and ignored
}

export default {
  platform: "telegram",
  // The bot token rides the request URL, so no caller-IP allowlist applies.
  outbound: { mode: "url-keyed", inbound: true },
  inboundModes: ["poll", "callback"],
  credentialFields: [
    { key: "token", label: "Bot token (BotFather)", secret: true },
    { key: "secretToken", label: "Webhook secret token (optional)", required: false, secret: true },
  ],
  createTransport,
  parseCallback,
};
