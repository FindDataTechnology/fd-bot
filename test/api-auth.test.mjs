// 调用面准入（openspec: authenticate-send-endpoint）。
//
// 每条都走**真实 HTTP**：不注入假鉴权器——那会让「生产没挂上」在测试里看不出来
// （design D5）。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createMemoryStore } from "../src/bindings.js";
import { createRegistry } from "../src/registry.js";
import { createAcceptance } from "../src/acceptance.js";
import { createDeliverer } from "../src/deliverer.js";
import { createTickets, buildEnvelope } from "../src/envelope.js";
import { createConnectionManager } from "../src/connections.js";

const SECRET = "test-media-secret-0123456789";
const TOKEN = "test-api-token-0123456789";

const stubPlatform = {
  platform: "stub",
  outbound: { mode: "url-keyed", inbound: true },
  inboundModes: ["callback"],
  credentialFields: [{ key: "token", label: "Token", secret: true }],
  createTransport() {
    return { inboundMode: "callback", async start() {}, async stop() {}, async sendText() {} };
  },
};

async function boot({ apiToken = TOKEN } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fd-bot-auth-"));
  const cfg = {
    dataDir,
    apiToken,
    credentialKey: "test-credential-key-0123456789",
    mediaSecret: SECRET,
    mediaTtlMs: 60_000,
    publicBaseUrl: null,
    delivery: { timeoutMs: 500, maxAttempts: 1 },
  };
  const registry = createRegistry([stubPlatform]);
  const store = createMemoryStore();
  const acceptance = createAcceptance({ dir: path.join(dataDir, "acc") });
  const deliverer = createDeliverer({ fetchImpl: async () => new Response("ok", { status: 200 }), log: { warn() {}, info() {} } });
  const tickets = createTickets(cfg);
  const connections = createConnectionManager({
    store, registry, acceptance, deliverer, tickets, buildEnvelope, log: { warn() {}, info() {} },
  });
  const app = createApp({ cfg, store, registry, connections, tickets, log: { warn() {}, info() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    app,
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const bearer = (t) => ({ authorization: `Bearer ${t}` });
const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// ── 3.1 无 token → 401，且不回显 body ──────────────────────────────────────

test("no bearer token is rejected, and the body is not echoed", async () => {
  const t = await boot();
  try {
    const res = await post(`${t.base}/v1/send`, { bindingId: "b_x", chatKey: "c", text: "CANARY-SHOULD-NOT-ECHO" });
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.ok(!text.includes("CANARY-SHOULD-NOT-ECHO"), "the body must not be reflected");
  } finally {
    await t.close();
  }
});

// ── 3.2 错 token 与缺失同形 ────────────────────────────────────────────────

test("a wrong token is byte-identical to a missing one", async () => {
  const t = await boot();
  try {
    const missing = await post(`${t.base}/v1/send`, { bindingId: "b", chatKey: "c", text: "x" });
    const wrong = await post(`${t.base}/v1/send`, { bindingId: "b", chatKey: "c", text: "x" }, bearer("nope-nope-nope"));
    assert.equal(wrong.status, 401);
    assert.equal(await missing.text(), await wrong.text(), "refusal must not reveal 'token exists but is wrong'");
  } finally {
    await t.close();
  }
});

// ── 3.3 正确 token → 原行为 ────────────────────────────────────────────────

test("the right token reaches the endpoint as before", async () => {
  const t = await boot();
  try {
    const created = await post(`${t.base}/v1/bindings`,
      { platform: "stub", credentials: { token: "t" }, subscriberUrl: "http://x.test/h" }, bearer(TOKEN));
    assert.equal(created.status, 201);
    const b = await created.json();
    const sent = await post(`${t.base}/v1/send`, { bindingId: b.id, chatKey: "c", text: "hi" }, bearer(TOKEN));
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { ok: true });
  } finally {
    await t.close();
  }
});

// ── 3.4 未配置 → 503，且 /health 仍 200 ────────────────────────────────────

test("an unconfigured token refuses with 503 and names the variable", async () => {
  const t = await boot({ apiToken: "" });
  try {
    const res = await post(`${t.base}/v1/send`, { bindingId: "b", chatKey: "c", text: "x" }, bearer("anything"));
    assert.equal(res.status, 503, "never fail open");
    assert.match(await res.text(), /FD_BOT_API_TOKEN/);
    // 反向断言：同一个实例上探针必须照常
    assert.equal((await fetch(`${t.base}/health`)).status, 200);
  } finally {
    await t.close();
  }
});

// ── 3.5 四个公开端点不受影响 ───────────────────────────────────────────────

test("public endpoints stay reachable without a bearer", async () => {
  const t = await boot();
  try {
    assert.equal((await fetch(`${t.base}/health`)).status, 200);
    assert.equal((await fetch(`${t.base}/v1/platforms`)).status, 200);
    // 媒体票据：无效票据应 410，与是否带 bearer 无关
    assert.equal((await fetch(`${t.base}/v1/media/bogus.ticket`)).status, 410);
    // 回调：未知 secret 应 403（由 per-binding secret 自证），不是 401
    assert.equal((await post(`${t.base}/v1/callbacks/stub/wrong`, {})).status, 403);
  } finally {
    await t.close();
  }
});

// ── 4.1 结构性闸：受保护前缀下每条路由都挂了 apiAuth ───────────────────────

test("every route under the protected prefixes carries the auth middleware", async () => {
  const t = await boot();
  try {
    // 只读内部字段，不碰 app.router 的 getter（它会抛「deprecated」）。
    const stack = t.app._router && t.app._router.stack;
    assert.ok(Array.isArray(stack), "Express route table unavailable — fail loudly, do not skip");

    const PROTECTED = ["/v1/bindings", "/v1/send"];
    const routes = [];
    for (const layer of stack) {
      const route = layer.route;
      if (!route) continue;
      if (!PROTECTED.some((p) => route.path === p || route.path.startsWith(p + "/") || route.path.startsWith(p))) continue;
      const names = route.stack.map((s) => s.name || "anonymous");
      routes.push({ path: route.path, names });
    }
    assert.ok(routes.length >= 5, `expected at least 5 protected routes, got ${routes.length}`);
    for (const r of routes) {
      // apiAuth 与 json 都是中间件；apiAuth 必须在 json 之前出现。
      const ai = r.names.findIndex((n) => n === "apiAuth");
      assert.ok(ai >= 0, `${r.path} has no apiAuth (stack: ${r.names.join(",")})`);
      const ji = r.names.findIndex((n) => n !== "apiAuth" && n !== "anonymous" && n !== "<anonymous>");
      if (ji >= 0) assert.ok(ai <= ji, `${r.path}: apiAuth must run before the body parser`);
    }
  } finally {
    await t.close();
  }
});
