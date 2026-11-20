// API surface: credentials never leave, capabilities are one source, failures
// are classified not disguised, tickets gate media.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../src/app.js";
import { createMemoryStore } from "../src/bindings.js";
import { createRegistry } from "../src/registry.js";
import { createAcceptance } from "../src/acceptance.js";
import { createDeliverer } from "../src/deliverer.js";
import { createTickets } from "../src/envelope.js";
import { createConnectionManager } from "../src/connections.js";
import { buildEnvelope } from "../src/envelope.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SECRET = "test-media-secret-0123456789";

function stubPlatform({ send = async () => {}, downloadMedia = null } = {}) {
  return {
    platform: "stub",
    outbound: { mode: "url-keyed", inbound: true },
    inboundModes: ["callback"],
    credentialFields: [{ key: "token", label: "Token", secret: true }],
    createTransport() {
      return {
        inboundMode: "callback",
        async start() {},
        async stop() {},
        async sendText(chatKey, text) {
          await send(chatKey, text);
        },
        ...(downloadMedia ? { downloadMedia } : {}),
      };
    },
  };
}

async function boot({ send, downloadMedia, registryAdapters } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fd-bot-app-"));
  const cfg = {
    dataDir,
    credentialKey: "test-credential-key-0123456789",
    mediaSecret: SECRET,
    mediaTtlMs: 5 * 60_000,
    publicBaseUrl: "http://localhost",
    delivery: { timeoutMs: 2_000, maxAttempts: 2 },
  };
  const adapter = stubPlatform({ send, downloadMedia });
  const registry = createRegistry(registryAdapters ?? [adapter]);
  const store = createMemoryStore();
  const acceptance = createAcceptance({ dir: path.join(dataDir, "acc") });
  const deliverer = createDeliverer({ timeoutMs: 500, maxAttempts: 1, fetchImpl: async () => new Response("ok", { status: 200 }), log: { warn() {}, info() {} } });
  const tickets = createTickets(cfg);
  const connections = createConnectionManager({
    store,
    registry,
    acceptance,
    deliverer,
    tickets,
    buildEnvelope,
    log: { warn() {}, info() {} },
  });
  const app = createApp({ cfg, store, registry, connections, tickets, log: { warn() {}, info() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    cfg,
    store,
    adapter,
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("capabilities come from the registry, all four fields present", async () => {
  const t = await boot();
  try {
    const res = await fetch(`${t.base}/v1/platforms`);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.deepEqual(body[0], { platform: "stub", outbound: { mode: "url-keyed", inbound: true }, inboundModes: ["callback"] });
  } finally {
    await t.close();
  }
});

test("creating a binding never echoes a credential value", async () => {
  const t = await boot();
  try {
    const res = await fetch(`${t.base}/v1/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "stub", credentials: { token: "super-secret-value" }, subscriberUrl: "http://example.test/hook" }),
    });
    assert.equal(res.status, 201);
    const text = await res.text();
    assert.ok(!text.includes("super-secret-value"), "response body must not contain the credential");
    const body = JSON.parse(text);
    assert.deepEqual(body.credentials, { configured: ["token"] });
    assert.ok(body.id);

    // Same on read.
    const read = await (await fetch(`${t.base}/v1/bindings/${body.id}`)).text();
    assert.ok(!read.includes("super-secret-value"));
  } finally {
    await t.close();
  }
});

test("unknown binding and unknown platform are distinct, honest errors", async () => {
  const t = await boot();
  try {
    const missing = await fetch(`${t.base}/v1/bindings/b_nope`);
    assert.equal(missing.status, 404);
    const badPlatform = await fetch(`${t.base}/v1/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "nope", credentials: {}, subscriberUrl: "http://x.test/h" }),
    });
    assert.equal(badPlatform.status, 400);
  } finally {
    await t.close();
  }
});

test("missing required credential is refused at save time", async () => {
  const t = await boot();
  try {
    const res = await fetch(`${t.base}/v1/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "stub", credentials: {}, subscriberUrl: "http://x.test/h" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /missing credentials: token/);
  } finally {
    await t.close();
  }
});

async function makeBinding(t, credentials = { token: "t" }) {
  const res = await fetch(`${t.base}/v1/bindings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "stub", credentials, subscriberUrl: "http://example.test/hook" }),
  });
  return res.json();
}

test("send failure carries a classification, never a fake success", async () => {
  const t = await boot({
    send: async () => {
      const e = new Error("errcode 60020 not allow to access from your ip");
      throw e;
    },
  });
  try {
    const b = await makeBinding(t);
    const res = await fetch(`${t.base}/v1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bindingId: b.id, chatKey: "c1", text: "hi" }),
    });
    assert.equal(res.status, 200, "a platform verdict is not a transport error");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.failure, "ip-not-allowed");
  } finally {
    await t.close();
  }
});

test("all three failure classes are distinguishable at the endpoint", async () => {
  const cases = [
    [, new Error("no live response_url for this chat"), "reply-window-closed"],
    ["reply-window-closed", "reply-window-closed"],
    [null, new Error("socket hang up"), "other"],
    [null, new Error("errcode 45015 response timeout"), "reply-window-closed"],
    [null, new Error("errcode 40164 invalid ip"), "ip-not-allowed"],
  ];
  for (const [, err, expected] of cases) {
    const t = await boot({
      send: async () => {
        throw err;
      },
    });
    try {
      const b = await makeBinding(t);
      const body = await (
        await fetch(`${t.base}/v1/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bindingId: b.id, chatKey: "c", text: "x" }),
        })
      ).json();
      assert.equal(body.ok, false);
      assert.equal(body.failure, expected, `${err.message} → ${expected}`);
      assert.ok(body.detail, "the operator needs a sentence, not just a code");
    } finally {
      await t.close();
    }
  }
});

test("a leg that declares outbound none refuses without pretending to try", async () => {
  const dead = { ...stubPlatform(), platform: "dead", outbound: { mode: "none", inbound: false } };
  const live = stubPlatform();
  const t = await boot({ registryAdapters: [dead, live] });
  try {
    const res = await fetch(`${t.base}/v1/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "dead", credentials: { token: "t" }, subscriberUrl: "http://x.test/h" }),
    });
    const b = await res.json();
    const send = await fetch(`${t.base}/v1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bindingId: b.id, chatKey: "c", text: "x" }),
    });
    const body = await send.json();
    assert.equal(body.ok, false);
    assert.match(body.detail, /declares outbound\.mode "none"/);
  } finally {
    await t.close();
  }
});

test("media tickets: valid ticket fetches, expired ticket does not", async () => {
  let clock = 1_000_000;
  const dataDir = mkdtempSync(path.join(tmpdir(), "fd-bot-media-"));
  const { createMediaTickets } = await import("../src/media.js");
  const tickets = createMediaTickets({ secret: SECRET, ttlMs: 1_000, now: () => clock });
  try {
    const url = tickets.issueFor({ bindingId: "b1", platformMessageId: "m1", index: 0, kind: "image", mime: "image/png" });
    const ticket = url.split("/").pop();
    assert.ok(tickets.read(ticket), "fresh ticket must verify");
    clock += 2_000;
    assert.equal(tickets.read(ticket), null, "expired ticket must not verify");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a tampered media ticket is rejected", async () => {
  const { createMediaTickets } = await import("../src/media.js");
  const tickets = createMediaTickets({ secret: SECRET, ttlMs: 60_000 });
  const url = tickets.issueFor({ bindingId: "b1", platformMessageId: "m1", index: 0, kind: "image" });
  const bad = `${url.split("/").pop().slice(0, -2)}xx`;
  assert.equal(tickets.read(bad), null);
  // A ticket signed with a different key must not verify under ours.
  const other = createMediaTickets({ secret: "different-secret-xxxxxxxx", ttlMs: 60_000 });
  assert.equal(tickets.read(other.issueFor({ bindingId: "b1", platformMessageId: "m1", index: 0, kind: "image" }).split("/").pop()), null);
});
