// Ported adapters: the platform protocols, moved without rewriting their logic.
//
// The point of these tests is the PORT, not the platforms: each adapter's
// self-check in paas proved the wire format once, and these assertions pin the
// same behaviour so a botched copy fails here instead of in a customer's group.
// Where a self-check exists upstream, its cases are reproduced.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import telegram, { updateToMessage } from "../src/adapters/telegram.js";
import slack, { splitChatKey, parseCallback as parseSlack } from "../src/adapters/slack.js";
import feishu, { parseCallback as parseFeishu, checkSignature } from "../src/adapters/feishu.js";

// ── telegram ────────────────────────────────────────────────────────────────

test("telegram: a text update becomes our message shape", () => {
  const msg = updateToMessage({
    update_id: 1,
    message: { message_id: 7, from: { id: 42, first_name: "Ada", username: "ada" }, chat: { id: -100123 }, text: "hello" },
  });
  assert.equal(msg.chatKey, "-100123");
  assert.equal(msg.senderName, "ada");
  assert.equal(msg.senderId, "42");
  assert.equal(msg.text, "hello");
  assert.equal(msg.platformMessageId, "7");
});

test("telegram: non-text updates are ignored, never guessed at", () => {
  assert.equal(updateToMessage({ update_id: 2, edited_message: {} }), null);
  assert.equal(updateToMessage({ update_id: 3 }), null);
});

test("telegram: declares a URL-keyed outbound path", () => {
  assert.deepEqual(telegram.outbound, { mode: "url-keyed", inbound: true });
  assert.ok(telegram.inboundModes.includes("poll"));
});

test("telegram: sendText posts to sendMessage with the chat id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  const t = telegram.createTransport({ credentials: { token: "T" } }, { fetchImpl });
  await t.sendText("-100123", "hi");
  assert.match(calls[0].url, /\/botT\/sendMessage$/);
  assert.deepEqual(calls[0].body, { chat_id: "-100123", text: "hi" });
});

test("telegram: a platform rejection surfaces as an error, not a silent success", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 });
  const t = telegram.createTransport({ credentials: { token: "T" } }, { fetchImpl });
  await assert.rejects(() => t.sendText("x", "y"), /chat not found/);
});

// ── slack ───────────────────────────────────────────────────────────────────

const slackSign = (raw, secret, ts = String(Math.floor(Date.now() / 1000))) => ({
  "x-slack-request-timestamp": ts,
  "x-slack-signature": `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`,
});

test("slack: url_verification echoes the challenge", () => {
  const raw = JSON.stringify({ type: "url_verification", challenge: "abc123" });
  const out = parseSlack({ raw: Buffer.from(raw), headers: slackSign(raw, "s3cr3t"), credentials: { signingSecret: "s3cr3t" } });
  assert.deepEqual(out, { handshake: '{"challenge":"abc123"}' });
});

test("slack: a thread reply keys on channel:thread_root", () => {
  const raw = JSON.stringify({
    type: "event_callback",
    event: { type: "message", channel: "C1", user: "U9", text: " @智语 你好 ", thread_ts: "111.2", event_ts: "111.3" },
  });
  const out = parseSlack({ raw: Buffer.from(raw), headers: slackSign(raw, "s3cr3t"), credentials: { signingSecret: "s3cr3t" } });
  assert.equal(out.message.chatKey, "C1:111.2");
  assert.equal(out.message.text, "@智语 你好");
  assert.equal(out.message.platformMessageId, "C1:111.3");
});

test("slack: bot echoes and edits are ignored (no loops, no double posts)", () => {
  for (const ev of [
    { type: "message", channel: "C1", text: "x", bot_id: "B1" },
    { type: "message", subtype: "bot_message", channel: "C1", text: "x" },
    { type: "message", subtype: "message_changed", channel: "C1", text: "x" },
  ]) {
    const raw = JSON.stringify({ type: "event_callback", event: ev });
    const out = parseSlack({ raw: Buffer.from(raw), headers: slackSign(raw, "s3cr3t"), credentials: { signingSecret: "s3cr3t" } });
    assert.equal(out.message, null, `ignored: ${ev.subtype ?? "bot"}`);
  }
});

test("slack: a tampered body and a stale timestamp are both refused", () => {
  const raw = JSON.stringify({ type: "event_callback", event: { type: "message", channel: "C1", text: "x" } });
  const cred = { signingSecret: "s3cr3t" };
  assert.throws(() => parseSlack({ raw: Buffer.from(`${raw} `), headers: slackSign(raw, "s3cr3t"), credentials: cred }), /bad signature/);
  assert.throws(() => parseSlack({ raw: Buffer.from(raw), headers: slackSign(raw, "s3cr3t", "1"), credentials: cred }), /stale/);
});

test("slack: chatKey splits back into what chat.postMessage needs", () => {
  assert.deepEqual(splitChatKey("C1:111.2"), { channel: "C1", threadTs: "111.2" });
  assert.deepEqual(splitChatKey("C1"), { channel: "C1", threadTs: null });
});

test("slack: declares the outbound path it actually has", () => {
  // The exact hole `add-mattermost-channel` found: no declaration at all.
  assert.deepEqual(slack.outbound, { mode: "url-keyed", inbound: true });
});

test("slack: {ok:false} in a 200 body is a failure", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
  const t = slack.createTransport({ credentials: { botToken: "x" } }, { fetchImpl });
  await assert.rejects(() => t.sendText("C1", "hi"), /invalid_auth/);
});

// ── feishu ──────────────────────────────────────────────────────────────────

const ENC_KEY = "test-encrypt-key";
const feishuEncrypt = (obj) => {
  const key = crypto.createHash("sha256").update(ENC_KEY).digest();
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, c.update(JSON.stringify(obj), "utf8"), c.final()]).toString("base64");
};
const feishuRequest = (obj) => {
  const raw = JSON.stringify({ encrypt: feishuEncrypt(obj) });
  const ts = "1700000000";
  const nonce = "abc";
  return {
    raw: Buffer.from(raw),
    headers: {
      "x-lark-request-timestamp": ts,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": crypto.createHash("sha256").update(ts + nonce + ENC_KEY + raw).digest("hex"),
    },
    credentials: { encryptKey: ENC_KEY },
  };
};

test("feishu: the URL-verification challenge is echoed verbatim", () => {
  const out = parseFeishu(feishuRequest({ type: "url_verification", challenge: "ch-123" }));
  assert.deepEqual(out, { handshake: '{"challenge":"ch-123"}' });
});

test("feishu: a text event is decrypted and parsed", () => {
  const out = parseFeishu(
    feishuRequest({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1" },
      event: { sender: { sender_id: { open_id: "ou_1" } }, message: { chat_id: "oc_9", message_type: "text", content: '{"text":"hi"}' } },
    }),
  );
  assert.equal(out.message.chatKey, "oc_9");
  assert.equal(out.message.text, "hi");
  assert.equal(out.message.senderId, "ou_1");
});

test("feishu: a tampered signature is refused before decrypt", () => {
  const req = feishuRequest({ type: "url_verification", challenge: "x" });
  req.headers["x-lark-signature"] = "0".repeat(64);
  assert.throws(() => parseFeishu(req), /bad signature/);
});

test("feishu: CBC is the scheme (the design doc said GCM and was wrong)", () => {
  // A round-trip through the same helpers proves the cipher, not the doc.
  const body = feishuEncrypt({ hello: "world" });
  assert.ok(!body.includes("world"), "payload must not travel in the clear");
  const out = parseFeishu(feishuRequest({ type: "url_verification", challenge: "c" }));
  assert.ok(out.handshake);
  assert.equal(typeof checkSignature, "function");
});

test("feishu: declares a URL-keyed outbound path", () => {
  assert.deepEqual(feishu.outbound, { mode: "url-keyed", inbound: true });
});
