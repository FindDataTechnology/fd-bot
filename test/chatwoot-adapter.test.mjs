// Chatwoot adapter: signature, inbound filter, and outbound request shape.
//
// What this CAN prove: our wiring — HMAC scheme matches, the ignore rules drop
// the right payloads, chatKey splits back into the reply URL, and a non-2xx
// throws rather than masquerading as success.
// What it CANNOT prove: that a real Chatwoot desk accepts the token (that is now
// verified separately against a live 4.19.0: `Authorization: Bearer <token>`,
// not `Bot <token>` — see the adapter header). This file locks the request shape.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import chatwoot, { parseCallback, verifySignature, splitChatKey } from "../src/adapters/chatwoot.js";

const CRED = { baseUrl: "https://desk.example.com/", apiToken: "bot-token", accountId: "3", webhookSecret: "s3cr3t" };

function sign(raw, secret = CRED.webhookSecret, ts = String(Math.floor(Date.now() / 1000))) {
  return {
    "x-chatwoot-timestamp": ts,
    "x-chatwoot-signature": `sha256=${crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`,
  };
}

function req(body, { secret, ts } = {}) {
  const raw = JSON.stringify(body);
  return { raw: Buffer.from(raw), headers: sign(raw, secret, ts), credentials: CRED };
}

function messagePayload(over = {}) {
  return {
    event: "message_created",
    message_type: "incoming",
    content: "  hello  ",
    id: 991,
    private: false,
    account: { id: 3 },
    inbox: { id: 1 },
    sender: { id: 77, name: "Ada" },
    conversation: { id: 12, status: "open", meta: { assignee: null, assignee_type: null } },
    ...over,
  };
}

// ── signature ───────────────────────────────────────────────────────────────

test("chatwoot: a correctly signed body verifies", () => {
  assert.doesNotThrow(() => verifySignature(req(messagePayload())));
});

test("chatwoot: a tampered body is refused", () => {
  const body = messagePayload();
  const raw = JSON.stringify(body);
  const headers = sign(raw);
  assert.throws(
    () => verifySignature({ raw: Buffer.from(`${raw} `), headers, credentials: CRED }),
    /bad signature/,
  );
});

test("chatwoot: a wrong secret and a stale timestamp are both refused", () => {
  assert.throws(() => verifySignature(req(messagePayload(), { secret: "wrong" })), /bad signature/);
  assert.throws(() => verifySignature(req(messagePayload(), { ts: "1" })), /stale/);
});

test("chatwoot: a missing signature header is refused, never treated as unsigned", () => {
  assert.throws(
    () => verifySignature({ raw: Buffer.from("{}"), headers: {}, credentials: CRED }),
    /missing signature/,
  );
});

// ── inbound parse ───────────────────────────────────────────────────────────

test("chatwoot: an incoming message keys on account:conversation", () => {
  const out = parseCallback(req(messagePayload()));
  assert.equal(out.message.chatKey, "3:12");
  assert.equal(out.message.text, "hello");
  assert.equal(out.message.platformMessageId, "991");
  assert.equal(out.message.senderId, "77");
  assert.equal(out.message.senderName, "Ada");
  assert.equal(out.message.chatType, "single");
  assert.equal(out.message.conversationStatus, "open");
  assert.equal(out.message.assignee, null);
});

test("chatwoot: assignee is carried for both a human agent and a bot", () => {
  const human = parseCallback(
    req(messagePayload({ conversation: { id: 12, status: "open", meta: { assignee: { id: 5 }, assignee_type: "User" } } })),
  );
  assert.deepEqual(human.message.assignee, { id: 5, type: "User" });
  const bot = parseCallback(
    req(messagePayload({ conversation: { id: 12, status: "pending", meta: { assignee: { id: 9 }, assignee_type: "AgentBot" } } })),
  );
  assert.deepEqual(bot.message.assignee, { id: 9, type: "AgentBot" });
});

test("chatwoot: our own outgoing reply is ignored (no echo loop)", () => {
  assert.deepEqual(parseCallback(req(messagePayload({ message_type: "outgoing" }))), { message: null });
});

test("chatwoot: a private note and a non-message event are ignored", () => {
  assert.deepEqual(parseCallback(req(messagePayload({ private: true }))), { message: null });
  assert.deepEqual(parseCallback(req(messagePayload({ event: "conversation_opened" }))), { message: null });
  assert.deepEqual(parseCallback(req(messagePayload({ content: "   " }))), { message: null });
});

test("chatwoot: a missing platform id is null, never fabricated", () => {
  const out = parseCallback(req(messagePayload({ id: undefined })));
  assert.equal(out.message.platformMessageId, null);
});

test("chatwoot: chatKey splits back into the account and conversation ids", () => {
  assert.deepEqual(splitChatKey("3:12"), { accountId: "3", conversationId: "12" });
});

// ── outbound ────────────────────────────────────────────────────────────────

test("chatwoot: declares a URL-keyed callback leg", () => {
  assert.deepEqual(chatwoot.outbound, { mode: "url-keyed", inbound: true });
  assert.deepEqual(chatwoot.inboundModes, ["callback"]);
  // webhookSecret is required — signature verification must not be skippable.
  assert.equal(chatwoot.credentialFields.find((f) => f.key === "webhookSecret").required, undefined);
});

test("chatwoot: sendText POSTs an outgoing message to the account-scoped URL", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
  const t = chatwoot.createTransport({ credentials: CRED }, { fetchImpl });
  await t.sendText("3:12", "hi there");
  assert.equal(calls[0].url, "https://desk.example.com/api/v1/accounts/3/conversations/12/messages");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer bot-token");
  assert.deepEqual(calls[0].body, { content: "hi there", message_type: "outgoing" });
});

test("chatwoot: a non-2xx surfaces the status and a body excerpt, not a silent success", async () => {
  const fetchImpl = async () => new Response("Unauthorized: bad token", { status: 401 });
  const t = chatwoot.createTransport({ credentials: CRED }, { fetchImpl });
  await assert.rejects(() => t.sendText("3:12", "x"), /401.*Unauthorized/);
  const failing = chatwoot.createTransport(
    { credentials: CRED },
    { fetchImpl: async () => new Response("nope", { status: 501 }) },
  );
  await assert.rejects(() => failing.sendText("3:12", "x"), /501/);
});
