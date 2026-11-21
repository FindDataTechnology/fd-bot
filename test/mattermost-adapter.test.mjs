// Mattermost adapter: the port, not the platform.
//
// Three groups of assertions, matching the source's self-check:
//   parseCallback  token gate (throws), thread/no-thread chatKey, echo drops,
//                  fail-closed channel allowlist
//   sendText       exact URL / bearer header / body, and a non-2xx throws
//   start()        the real websocket path against a local fake instance:
//                  auth frame, human posts delivered, bot + no-user_id dropped,
//                  and stop() closes the socket
// What this CANNOT prove: that a real Mattermost accepts us. That is a real-
// egress task, per docs/OPERATIONS.md §1.4.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import mattermost, { parseCallback, splitChatKey, allowedChannelsOf } from "../src/adapters/mattermost.js";
import { adapterProblems, createRegistry } from "../src/registry.js";
import { adapters } from "../src/adapters/index.js";

const CRED = { siteUrl: "https://im.example.com/", botToken: "tok", webhookToken: "whsec", botUserId: "bot1", allowedChannels: "C1" };

const req = (body, credentials = CRED) => ({ raw: Buffer.from(JSON.stringify(body)), headers: {}, query: {}, method: "POST", credentials });

// ── declaration + registry ──────────────────────────────────────────────────

test("mattermost: declares a URL-keyed leg with both inbound shapes", () => {
  assert.deepEqual(mattermost.outbound, { mode: "url-keyed", inbound: true });
  assert.deepEqual(mattermost.inboundModes, ["callback", "subscribe"]);
  assert.deepEqual(adapterProblems(mattermost), []);
});

test("mattermost: credential keys are the source's, so existing rows map", () => {
  const keys = mattermost.credentialFields.map((f) => f.key);
  assert.deepEqual(keys, ["siteUrl", "botToken", "webhookToken", "allowedChannels", "botUserId", "qrUrl"]);
  assert.deepEqual(mattermost.qr, { strategy: "manual", field: "qrUrl", hintKey: "botsPage.qr.hint.manual" });
  const siteUrl = mattermost.credentialFields.find((f) => f.key === "siteUrl");
  assert.equal(siteUrl.validate("https://im.example.com"), null);
  assert.ok(siteUrl.validate("im.example.com"));
});

test("mattermost: the registry boots with it registered", () => {
  const registry = createRegistry(adapters);
  assert.equal(registry.get("mattermost"), mattermost);
});

// ── parseCallback: token gate ──────────────────────────────────────────────

test("mattermost: a wrong or missing webhook token is refused", () => {
  assert.throws(() => parseCallback(req({ token: "nope", channel_id: "C1", user_id: "u1", text: "x" })), /bad webhook token/);
  assert.throws(() => parseCallback(req({ channel_id: "C1", user_id: "u1", text: "x" })), /bad webhook token/);
  // An unconfigured webhookToken never authorizes (no "empty matches empty").
  assert.throws(() => parseCallback(req({ token: "", text: "x" }, { ...CRED, webhookToken: "" })), /bad webhook token/);
  // Unreadable bytes are a refusal, not an unauthenticated parse.
  assert.throws(() => parseCallback({ raw: Buffer.from("{nope"), headers: {}, credentials: CRED }), /unreadable/);
});

// ── parseCallback: message shape ───────────────────────────────────────────

test("mattermost: a threaded reply keys on the thread root", () => {
  const { message } = parseCallback(req({ token: "whsec", channel_id: "C1", post_id: "P9", root_id: "P3", user_id: "u1", user_name: "ada", text: " hi " }));
  assert.equal(message.chatKey, "C1:P3");
  assert.equal(message.platformMessageId, "C1:P9");
  assert.equal(message.text, "hi");
  assert.equal(message.senderName, "ada");
});

test("mattermost: a channel-level post keys on its own id", () => {
  const { message } = parseCallback(req({ token: "whsec", channel_id: "C1", post_id: "P9", user_id: "u1", text: "hi" }));
  assert.equal(message.chatKey, "C1:P9");
  assert.equal(message.platformMessageId, "C1:P9");
});

test("mattermost: bot echo and the integration's own post are dropped", () => {
  const base = { token: "whsec", channel_id: "C1", post_id: "P9", text: "answer" };
  assert.deepEqual(parseCallback(req({ ...base, user_id: "bot1" })), { message: null });
  assert.deepEqual(parseCallback(req(base)), { message: null }); // no user_id at all
});

test("mattermost: an undeclared channel is dropped, and empty means none", () => {
  assert.deepEqual(parseCallback(req({ token: "whsec", channel_id: "OTHER", post_id: "P1", user_id: "u1", text: "x" })), { message: null });
  assert.deepEqual([...allowedChannelsOf({})], []);
  assert.deepEqual([...allowedChannelsOf({ allowedChannels: "C1, C2" })], ["C1", "C2"]);
});

test("mattermost: chatKey splits back into what POST /api/v4/posts needs", () => {
  assert.deepEqual(splitChatKey("C1"), { channelId: "C1", rootId: null });
  assert.deepEqual(splitChatKey("C1:P9"), { channelId: "C1", rootId: "P9" });
});

// ── sendText ───────────────────────────────────────────────────────────────

test("mattermost: sendText posts the exact request and threads when asked", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response("{}", { status: 201 });
  };
  const t = mattermost.createTransport({ credentials: CRED }, { fetchImpl });
  await t.sendText("C1:P9", "hello");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://im.example.com/api/v4/posts");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.deepEqual(calls[0].body, { channel_id: "C1", message: "hello", root_id: "P9" });
});

test("mattermost: an unthreaded send carries no root_id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response("{}", { status: 201 });
  };
  const t = mattermost.createTransport({ credentials: CRED }, { fetchImpl });
  await t.sendText("C1", "hello");
  assert.deepEqual(calls[0], { channel_id: "C1", message: "hello" });
});

test("mattermost: a non-2xx throws instead of passing as success", async () => {
  const fetchImpl = async () => new Response("Invalid or expired session", { status: 401 });
  const t = mattermost.createTransport({ credentials: CRED }, { fetchImpl });
  await assert.rejects(() => t.sendText("C1", "x"), /401.*Invalid or expired session/);
});

test("mattermost: callback mode is a no-op start (the platform calls us)", async () => {
  const t = mattermost.createTransport({ credentials: CRED, inboundMode: "callback" }, {});
  assert.equal(t.inboundMode, "callback");
  await t.start(() => assert.fail("must not dial in callback mode"));
  await t.stop();
});

// ── start(): the websocket path, against a real local server ───────────────
//
// A ~60-line RFC 6455 server (handshake + text frames + close). Node 20+/22 has
// a global WebSocket client but no server, and adding `ws` for a test is not
// worth a dependency. Only what this test sends is implemented: no extensions,
// no fragmentation, no ping.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverTextFrame(str) {
  const data = Buffer.from(str, "utf8");
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 126;
  head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

/** Client frames are always masked; returns the complete ones, ignores partials. */
function clientFrames(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const opcode = buf[i] & 0x0f;
    let len = buf[i + 1] & 0x7f;
    let off = i + 2;
    if (len === 126) {
      if (off + 2 > buf.length) break;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (off + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    const key = buf.subarray(off, off + 4);
    off += 4;
    if (off + len > buf.length) break; // frame still in flight
    const payload = Buffer.alloc(len);
    for (let k = 0; k < len; k++) payload[k] = buf[off + k] ^ key[k % 4];
    out.push({ opcode, text: payload.toString("utf8") });
    i = off + len;
  }
  return out;
}

async function startFakeInstance() {
  const state = { authFrames: [], socketClosed: false };
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("close", () => {
      state.socketClosed = true;
    });
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (const frame of clientFrames(buf)) {
        buf = Buffer.alloc(0); // only whole frames are ever buffered here
        if (frame.opcode === 0x8) {
          socket.end();
          state.socketClosed = true;
        } else if (frame.opcode === 0x1 && state.authFrames.length === 0) {
          state.authFrames.push(frame.text);
          const posted = (post) => serverTextFrame(JSON.stringify({ event: "posted", data: { post: JSON.stringify(post), sender_name: "ada" } }));
          socket.write(serverTextFrame(JSON.stringify({ event: "hello", data: {} })));
          socket.write(posted({ id: "P1", channel_id: "C1", user_id: "u1", message: "first" }));
          socket.write(posted({ id: "P2", channel_id: "C1", user_id: "bot1", message: "our own answer" }));
          socket.write(posted({ id: "P3", channel_id: "C1", user_id: "u1", message: "second" }));
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { state, port, close: () => server.close() };
}

const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return predicate();
};

test("mattermost: subscribe authenticates, delivers human posts, and stop() closes the socket", async () => {
  const fake = await startFakeInstance();
  const got = [];
  const t = mattermost.createTransport(
    { inboundMode: "subscribe", credentials: { ...CRED, siteUrl: `http://127.0.0.1:${fake.port}` } },
    {},
  );
  try {
    await t.start((m) => got.push(m));
    assert.equal(t.reportsState, true, "the subscribe leg owns the truth about its socket");

    assert.ok(await waitFor(() => got.length >= 2), "both human posts must arrive");
    assert.deepEqual(got.map((m) => m.text), ["first", "second"], "the bot's own echo must not be delivered");
    assert.equal(got[0].chatKey, "C1:P1", "a channel-level post keys on its own id");
    assert.equal(got[0].platformMessageId, "C1:P1");
    assert.equal(got[0].senderName, "ada");

    // The auth frame is the wire contract: exact action + the bot token.
    assert.equal(fake.state.authFrames.length, 1);
    assert.deepEqual(JSON.parse(fake.state.authFrames[0]), { seq: 1, action: "authentication_challenge", data: { token: "tok" } });

    await t.stop();
    assert.ok(await waitFor(() => fake.state.socketClosed), "stop() must close the socket");
  } finally {
    await t.stop();
    fake.close();
  }
});
