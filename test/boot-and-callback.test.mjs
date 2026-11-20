// Startup refusal and callback-path durability. Two behaviours that only exist
// to fail loudly, so each needs a red proof.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { createMemoryStore } from "../src/bindings.js";
import { createRegistry } from "../src/registry.js";
import { createAcceptance } from "../src/acceptance.js";
import { createDeliverer } from "../src/deliverer.js";
import { createTickets, buildEnvelope } from "../src/envelope.js";
import { createConnectionManager } from "../src/connections.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SECRET = "test-media-secret-0123456789";

function runService(env) {
  return spawnSync(process.execPath, ["src/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: "0", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("missing config secrets stops the process (exit 2)", () => {
  const r = runService({ FD_BOT_MEDIA_SECRET: "", FD_BOT_CREDENTIAL_KEY: "" });
  assert.notEqual(r.status, 0);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /FD_BOT_MEDIA_SECRET/);
});

test("an adapter without a valid outbound capability refuses to boot (exit 3)", () => {
  // Point the registry at a deliberately broken adapter through a temp entry
  // module, so the assertion covers the real boot path, not a unit call.
  const dir = mkdtempSync(path.join(tmpdir(), "fd-bot-boot-"));
  const entry = path.join(dir, "index.js");
  writeFileSync(
    entry,
    `import base from ${JSON.stringify(path.join(ROOT, "src/adapters/wecom-bot.js"))};
export const adapters = [{ ...base, outbound: undefined }];\n`,
  );
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { createRegistry } from ${JSON.stringify(path.join(ROOT, "src/registry.js"))};
      const { adapters } = await import(${JSON.stringify(entry)});
      try { createRegistry(adapters); console.log("BOOTED"); process.exit(0); }
      catch (e) { console.error(e.message); process.exit(3); }
    `], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 3, `expected refusal, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /outbound/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function bootCallback({ maxRecords = 5000 } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fd-bot-cb-"));
  const cfg = {
    dataDir,
    credentialKey: "test-credential-key-0123456789",
    mediaSecret: SECRET,
    mediaTtlMs: 60_000,
    publicBaseUrl: null,
    delivery: { timeoutMs: 1_000, maxAttempts: 1 },
  };
  const delivered = [];
  const adapter = {
    platform: "stub",
    outbound: { mode: "url-keyed", inbound: true },
    inboundModes: ["callback"],
    credentialFields: [{ key: "token", label: "Token", secret: true }],
    createTransport() {
      return { inboundMode: "callback", async start() {}, async stop() {}, async sendText() {} };
    },
    async parseCallback({ raw }) {
      const body = JSON.parse(raw.toString("utf8"));
      if (body.handshake) return { handshake: "echo-ok" };
      return { message: { chatKey: "c1", text: body.text, platformMessageId: body.id ?? null } };
    },
  };
  const registry = createRegistry([adapter]);
  const store = createMemoryStore();
  const acceptance = createAcceptance({ dir: path.join(dataDir, "acc"), maxRecords });
  const deliverer = createDeliverer({
    timeoutMs: 500,
    maxAttempts: 1,
    fetchImpl: async (url, init) => {
      delivered.push(JSON.parse(init.body));
      return new Response("ok", { status: 200 });
    },
    log: { warn() {}, info() {} },
  });
  const tickets = createTickets(cfg);
  const connections = createConnectionManager({
    store, registry, acceptance, deliverer, tickets, buildEnvelope, log: { warn() {}, info() {} },
  });
  const app = createApp({ cfg, store, registry, connections, tickets, log: { warn() {}, info() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await (
    await fetch(`${base}/v1/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "stub", credentials: { token: "t" }, subscriberUrl: "http://sub.test/hook" }),
    })
  ).json();
  return {
    base,
    binding: created,
    acceptance,
    delivered,
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("callback handshake is echoed verbatim", async () => {
  const t = await bootCallback();
  try {
    const res = await fetch(`${t.base}${t.binding.callbackUrl}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ handshake: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "echo-ok");
  } finally {
    await t.close();
  }
});

test("a callback with an unknown secret is refused before parsing", async () => {
  const t = await bootCallback();
  try {
    const res = await fetch(`${t.base}/v1/callbacks/stub/totally-wrong`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(res.status, 403);
    assert.equal(t.delivered.length, 0, "nothing may be delivered for a refused callback");
  } finally {
    await t.close();
  }
});

test("persist failure answers the platform non-2xx so it retries", async () => {
  const t = await bootCallback({ maxRecords: 0 });
  try {
    const res = await fetch(`${t.base}${t.binding.callbackUrl}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ text: "hi", id: "m1" }),
    });
    assert.equal(res.status, 503, "a message not on disk must not be acked");
    assert.equal(t.delivered.length, 0);
  } finally {
    await t.close();
  }
});

test("one accepted message is delivered exactly once", async () => {
  const t = await bootCallback();
  try {
    const post = (id) =>
      fetch(`${t.base}${t.binding.callbackUrl}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ text: "hi", id }),
      });
    assert.equal((await post("m1")).status, 200);
    await new Promise((r) => setTimeout(r, 150)); // delivery is asynchronous by design
    assert.equal(t.delivered.length, 1);
    assert.equal(t.delivered[0].platformMessageId, "m1");
    // Replay of the same platform id: confirmed, not re-delivered.
    assert.equal((await post("m1")).status, 200);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.delivered.length, 1);
  } finally {
    await t.close();
  }
});
