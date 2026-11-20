// wecom-bot transport, against a stub SDK client.
//
// What this CAN prove: our wiring — that connect() is called, that the platform
// frame is mapped to our message shape, that sendText uses the markdown body the
// platform requires, and that a media ticket resolves through the per-file
// aeskey rather than a guess.
//
// What it CANNOT prove, and must not be read as proving: that the platform
// accepts us. That is task 5.2's job on a real egress, because the whole
// question there is whether the trusted-IP allowlist applies to this channel.
import test from "node:test";
import assert from "node:assert/strict";
import { createTransport } from "../src/adapters/wecom-bot.js";

function stubClient() {
  const handlers = new Map();
  const calls = [];
  const client = {
    connect() {
      calls.push({ kind: "connect" });
      return client;
    },
    disconnect() {
      calls.push({ kind: "disconnect" });
    },
    on(event, fn) {
      handlers.set(event, fn);
      return client;
    },
    async sendMessage(chatid, body) {
      calls.push({ kind: "sendMessage", chatid, body });
    },
    async downloadFile(url, aesKey) {
      calls.push({ kind: "downloadFile", url, aesKey });
      return { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filename: "photo.jpg" };
    },
    emit(event, payload) {
      handlers.get(event)?.(payload);
    },
  };
  return { client, calls };
}

const binding = { credentials: { botId: "bot-1", secret: "s-1" } };

test("start dials the socket and authenticates with the binding's own credentials", async () => {
  const { client, calls } = stubClient();
  let opts = null;
  const t = createTransport(binding, { createClient: (o) => ((opts = o), client) });
  await t.start(() => {});
  assert.equal(opts.botId, "bot-1");
  assert.equal(opts.secret, "s-1");
  assert.equal(opts.maxReconnectAttempts, -1, "a platform outage must not require an operator restart");
  assert.deepEqual(calls.map((c) => c.kind), ["connect"]);
});

test("a group text frame becomes one message with the group's chatid as chatKey", async () => {
  const { client } = stubClient();
  const got = [];
  const t = createTransport(binding, { createClient: () => client });
  await t.start((m) => got.push(m));
  client.emit("message", {
    body: { msgid: "m-1", chattype: "group", chatid: "chat-9", from: { userid: "u1" }, msgtype: "text", text: { content: "@bot hi" } },
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].chatKey, "chat-9");
  assert.equal(got[0].senderId, "u1");
  assert.equal(got[0].text, "@bot hi");
  assert.equal(got[0].platformMessageId, "m-1");
});

test("a single chat uses the member id as chatKey", async () => {
  const { client } = stubClient();
  const got = [];
  const t = createTransport(binding, { createClient: () => client });
  await t.start((m) => got.push(m));
  client.emit("message", {
    body: { msgid: "m-2", chattype: "single", from: { userid: "u2" }, msgtype: "text", text: { content: "hi" } },
  });
  assert.equal(got[0].chatKey, "u2");
});

test("an image message carries media, not a silent text downgrade", async () => {
  const { client } = stubClient();
  const got = [];
  const t = createTransport(binding, { createClient: () => client });
  await t.start((m) => got.push(m));
  client.emit("message", {
    body: {
      msgid: "m-3",
      chattype: "group",
      chatid: "c",
      from: { userid: "u" },
      msgtype: "image",
      image: { url: "https://wx.test/img", aeskey: "k-1" },
    },
  });
  assert.equal(got[0].media.length, 1);
  assert.equal(got[0].media[0].kind, "image");
});

test("mixed messages keep both the text half and the images", async () => {
  const { client } = stubClient();
  const got = [];
  const t = createTransport(binding, { createClient: () => client });
  await t.start((m) => got.push(m));
  client.emit("message", {
    body: {
      msgid: "m-4",
      chattype: "group",
      chatid: "c",
      from: { userid: "u" },
      msgtype: "mixed",
      mixed: {
        text: { content: "look" },
        msg_item: [{ msgtype: "image", image: { url: "https://wx.test/a", aeskey: "ka" } }],
      },
    },
  });
  assert.equal(got[0].text, "look");
  assert.equal(got[0].media.length, 1);
});

test("voice contributes the platform's transcription as text", async () => {
  const { client } = stubClient();
  const got = [];
  const t = createTransport(binding, { createClient: () => client });
  await t.start((m) => got.push(m));
  client.emit("message", {
    body: { msgid: "m-5", chattype: "single", from: { userid: "u" }, msgtype: "voice", voice: { content: "spoken words" } },
  });
  assert.equal(got[0].text, "spoken words");
});

test("sendText uses markdown — the only shape a WeCom bot renders", async () => {
  const { client, calls } = stubClient();
  const t = createTransport(binding, { createClient: () => client });
  await t.start(() => {});
  await t.sendText("chat-9", "**hi**");
  const sent = calls.find((c) => c.kind === "sendMessage");
  assert.equal(sent.chatid, "chat-9");
  assert.deepEqual(sent.body, { msgtype: "markdown", markdown: { content: "**hi**" } });
});

test("media resolves through the ticket's message id and its own aeskey", async () => {
  const { client, calls } = stubClient();
  const t = createTransport(binding, { createClient: () => client });
  await t.start(() => {});
  client.emit("message", {
    body: {
      msgid: "m-6",
      chattype: "group",
      chatid: "c",
      from: { userid: "u" },
      msgtype: "image",
      image: { url: "https://wx.test/i", aeskey: "per-file-key" },
    },
  });
  const item = await t.downloadMedia({ platformMessageId: "m-6", index: 0 });
  assert.ok(item.buffer.length > 0);
  assert.equal(item.mime, "image/jpeg");
  const dl = calls.find((c) => c.kind === "downloadFile");
  assert.equal(dl.aesKey, "per-file-key", "each file's own aeskey, never a shared one");
  // An unknown message id resolves to nothing rather than fetching a guess.
  assert.equal(await t.downloadMedia({ platformMessageId: "m-nope", index: 0 }), null);
});

test("stop is idempotent and clears cached media", async () => {
  const { client, calls } = stubClient();
  const t = createTransport(binding, { createClient: () => client });
  await t.start(() => {});
  client.emit("message", {
    body: { msgid: "m-7", chattype: "group", chatid: "c", from: { userid: "u" }, msgtype: "image", image: { url: "u", aeskey: "k" } },
  });
  await t.stop();
  await t.stop();
  assert.equal(calls.filter((c) => c.kind === "disconnect").length, 1);
  assert.equal(await t.downloadMedia({ platformMessageId: "m-7", index: 0 }), null);
});

test("declares a real outbound path and no callback mode", async () => {
  const { default: adapter } = await import("../src/adapters/wecom-bot.js");
  assert.equal(adapter.outbound.inbound, true);
  // Task 5.2 evidence: sendMessage(chatid) over the long connection returned
  // errcode 0 in 360ms / 308ms on two groups with NO prior inbound. We dial the
  // platform, so there is no caller address to allowlist — an egress change
  // cannot break this leg. Asserting the MEASURED value, not "not none".
  assert.equal(adapter.outbound.mode, "url-keyed");
  assert.deepEqual(adapter.inboundModes, ["long-connection"]);
});

test("chatType distinguishes a group from a direct message", async () => {
  // Found on a real inbound (2026-11-20): a group frame is chattype:"group" +
  // chatid, a direct one is chattype:"single" with no chatid, and both collapse
  // to one string in chatKey. The platform answers them through different APIs,
  // so a consumer that has to guess gets it wrong half the time.
  const { client } = stubClient();
  const got = [];
  const t = createTransport(binding, { createClient: () => client });
  await t.start((m) => got.push(m));
  client.emit("message", {
    body: { msgid: "g1", chattype: "group", chatid: "wrG", from: { userid: "u" }, msgtype: "text", text: { content: "hi" } },
  });
  client.emit("message", {
    body: { msgid: "s1", chattype: "single", from: { userid: "u" }, msgtype: "text", text: { content: "hi" } },
  });
  assert.equal(got[0].chatType, "group");
  assert.equal(got[1].chatType, "single");
});
