// HTTP surface. Four endpoints plus the callback and media faces.
//
// The API's job is to be a thin, honest face over the store, the connections and
// the deliverer. It never re-derives capabilities (registry does), never returns
// a credential (bindings.toPublic does), and never turns a platform verdict into
// a 5xx (failure.js explains why).
import express from "express";
import { toPublic } from "./bindings.js";
import { classifyFailure, describeFailure } from "./failure.js";
import { tokenMatches } from "./ids.js";

export function createApp({ cfg, store, registry, connections, tickets, log = console, fetchImpl = null }) {
  const app = express();
  app.disable("x-powered-by");
  // JSON bodies for our own endpoints. The platform callback face needs the raw
  // body for signature checks, so it is mounted with its own parser below.
  const json = express.json({ limit: "2mb" });

  // ── 调用面准入（authenticate-send-endpoint）────────────────────────────────
  //
  // 「能改投递目的地」（/v1/bindings*）与「能发消息」（/v1/send）必须有凭据。
  // 任何能在集群里起 pod 的东西都能打到 8791，这两个端点裸奔等于「任何 pod
  // 都能以我们的平台身份往任意群发消息」。
  //
  // 两个刻意选择：
  //   · 未配置 token → 503 而不是放行。默认放行的鉴权等于没有鉴权。
  //     也不是拒绝启动——/health 必须能答，否则运维看到的是「整个服务挂了」
  //     而不是「差一个 token」（design D2）。
  //   · 挂在 json 解析器**之前**：body 里是告警正文与 binding 凭据，
  //     先解析再验等于让未鉴权的请求把内容送进内存与日志路径（design D3）。
  const PROTECTED = ["/v1/bindings", "/v1/send"];
  const apiAuth = (req, res, next) => {
    const expected = String(cfg.apiToken || "");
    if (!expected) {
      return res.status(503).json({
        error: "this endpoint requires FD_BOT_API_TOKEN, which this deployment has not set",
      });
    }
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || "").trim());
    // 缺失与错误同形（同为 401）：不泄露「token 存在但错」。
    if (!m || !tokenMatches(m[1].trim(), expected)) {
      return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    }
    next();
  };

  app.get("/health", (req, res) => {
    res.json({ ok: true, bindings: connections.entries.size });
  });

  // One source of capabilities: the registry, which validates at boot.
  app.get("/v1/platforms", (req, res) => {
    res.json(registry.capabilities());
  });

  app.post("/v1/bindings", apiAuth, json, async (req, res) => {
    const { platform, credentials, subscriberUrl, inboundMode, label, deliveryToken } = req.body ?? {};
    const adapter = registry.get(String(platform ?? ""));
    if (!adapter) return res.status(400).json({ error: `unknown platform "${platform}"` });
    if (!credentials || typeof credentials !== "object") {
      return res.status(400).json({ error: "credentials object is required" });
    }
    if (!/^https?:\/\//.test(String(subscriberUrl ?? ""))) {
      return res.status(400).json({ error: "subscriberUrl must be an http(s) URL" });
    }
    // Field-shape checks live with the adapter, so a credential that is PRESENT
    // but unusable is refused at save time instead of failing at send time when
    // someone is waiting for an answer.
    const missing = (adapter.credentialFields ?? [])
      .filter((f) => f.required !== false && !String(credentials[f.key] ?? "").trim())
      .map((f) => f.key);
    if (missing.length) return res.status(400).json({ error: `missing credentials: ${missing.join(", ")}` });
    const modes = adapter.inboundModes ?? ["callback"];
    // A push-only leg (inbound:false) still needs a binding — that is how you
    // SEND through it. It simply has no inbound mode, and saying "none"
    // explicitly beats recording a mode the adapter cannot honour.
    const pushOnly = adapter.outbound.inbound === false || modes.length === 0;
    const mode = pushOnly ? "none" : (inboundMode ?? modes[0]);
    if (!pushOnly && !modes.includes(mode)) {
      return res.status(400).json({ error: `inboundMode must be one of ${modes.join(", ")}` });
    }

    const row = await store.create({
      platform: adapter.platform,
      credentials,
      subscriberUrl: String(subscriberUrl),
      inboundMode: mode,
      label: label ?? null,
      deliveryToken: typeof deliveryToken === "string" && deliveryToken.length >= 16 ? deliveryToken : null,
    });
    const health = await connections.startBinding(row);
    res.status(201).json({ ...toPublic(row, { adapter }), health });
  });

  app.get("/v1/bindings/:id", apiAuth, async (req, res) => {
    const row = await store.get(req.params.id);
    if (!row || row.disabledAt) return res.status(404).json({ error: "not found" });
    const adapter = registry.get(row.platform);
    res.json({ ...toPublic(row, { adapter }), health: connections.stateOf(row.id) });
  });

  // Retire a binding. Added after a real incident (2026-11-20): a long-connection
  // platform allows ONE live connection per bot, so duplicate bindings actively
  // fight each other — each new connection makes the platform drop the previous
  // one (`disconnected_event`), and there was no way to remove the extras.
  // A binding can never be hard-deleted here: the acceptance queue and the
  // operator's audit both reference it by id.
  app.delete("/v1/bindings/:id", apiAuth, async (req, res) => {
    const row = await store.get(req.params.id);
    if (!row || row.disabledAt) return res.status(404).json({ error: "not found" });
    // Stop the connection BEFORE marking it disabled: a disabled row whose socket
    // is still open would keep receiving messages nobody is allowed to ask about.
    await connections.stopBinding(row.id);
    const ok = await store.disable(row.id);
    if (!ok) return res.status(409).json({ error: "could not disable binding" });
    log.info(`[bindings] ${row.id} (${row.platform}) retired`);
    res.json({ ok: true, id: row.id, platform: row.platform, disabledAt: Date.now() });
  });

  // List active bindings — needed to FIND duplicates, which the incident showed
  // is not something an operator can do from outside.
  app.get("/v1/bindings", apiAuth, async (req, res) => {
    const rows = await store.list();
    res.json(
      rows.map((row) => ({
        ...toPublic(row, { adapter: registry.get(row.platform) }),
        health: connections.stateOf(row.id),
      })),
    );
  });

  app.post("/v1/send", apiAuth, json, async (req, res) => {
    const { bindingId, chatKey, text } = req.body ?? {};
    if (!bindingId || !chatKey || typeof text !== "string") {
      return res.status(400).json({ error: "bindingId, chatKey and text are required" });
    }
    const row = await store.get(String(bindingId));
    if (!row || row.disabledAt) return res.status(404).json({ error: "unknown binding" });
    const adapter = registry.get(row.platform);
    if (!adapter) return res.status(409).json({ error: `platform "${row.platform}" has no adapter` });
    if (adapter.outbound.mode === "none") {
      // A declared-dead outbound path is a configuration fact, not a failure to
      // retry. Say so without pretending to have tried.
      return res.status(200).json({
        ok: false,
        failure: "other",
        detail: `platform "${row.platform}" declares outbound.mode "none"`,
      });
    }
    await connections.startBinding(row);
    const transport = connections.entries.get(row.id)?.transport;
    if (!transport?.sendText) {
      return res.status(200).json({ ok: false, failure: "other", detail: "transport has no sendText" });
    }
    try {
      await transport.sendText(chatKey, text);
      return res.json({ ok: true });
    } catch (err) {
      const failure = classifyFailure(err);
      log.warn(`[send] binding ${row.id} (${row.platform}) failed as ${failure}: ${err.message}`);
      return res.status(200).json({ ok: false, failure, detail: describeFailure(failure, err.message) });
    }
  });

  // Short-lived media fetch. The ticket IS the authority: it names one item of
  // one message of one binding. No caller-supplied URL is ever fetched.
  app.get("/v1/media/:ticket", async (req, res) => {
    const claim = tickets.read(req.params.ticket);
    if (!claim) return res.status(410).json({ error: "media ticket expired or invalid" });
    const row = await store.get(claim.bindingId);
    if (!row || row.disabledAt) return res.status(410).json({ error: "binding no longer exists" });
    const transport = connections.entries.get(row.id)?.transport;
    if (!transport?.downloadMedia) return res.status(501).json({ error: "platform has no media path" });
    try {
      const item = await transport.downloadMedia({
        platformMessageId: claim.platformMessageId,
        index: claim.index,
        kind: claim.kind,
      });
      if (!item) return res.status(404).json({ error: "media no longer available" });
      res.setHeader("content-type", item.mime || "application/octet-stream");
      res.setHeader("cache-control", "private, no-store");
      res.send(item.buffer);
    } catch (err) {
      log.warn(`[media] fetch failed for binding ${row.id}: ${err.message}`);
      res.status(502).json({ error: "upstream media fetch failed" });
    }
  });

  // Platform callback faces.
  //
  // TWO shapes, because the platforms do not agree on the method:
  //   POST  every current platform
  //   GET   the WeCom self-built app and the WeChat official account BOTH do
  //         their one-time URL echo-verify as a GET carrying echostr. A POST-only
  //         route cannot complete that handshake at all, and the failure is
  //         invisible until someone configures the callback URL in the console.
  //
  // Raw body preserved (signature schemes need the exact bytes). The same handler
  // runs for both verbs; only `method` is passed through to the parser.
  const callbackHandler = async (req, res) => {
    const adapter = registry.get(req.params.platform);
    if (!adapter) return res.status(404).json({ error: "unknown platform" });
    const binding = (await store.list()).find(
      (b) => b.platform === adapter.platform && tokenMatches(req.params.secret, b.callbackSecret),
    );
    if (!binding) return res.status(403).json({ error: "no binding matches this callback" });
    if (!adapter.parseCallback) return res.status(501).json({ error: "platform has no callback parser" });

    let parsed;
    try {
      parsed = await adapter.parseCallback({
        raw: req.body,
        headers: req.headers,
        query: req.query,
        method: req.method,
        credentials: binding.credentials,
      });
    } catch (err) {
      // Unverifiable input is refused before any content is used or logged.
      log.warn(`[callback] ${adapter.platform} rejected: ${err.message}`);
      return res.status(403).json({ error: "rejected" });
    }
    if (parsed?.handshake) return res.type("text/plain").send(String(parsed.handshake));
    if (!parsed?.message) return res.status(200).send("ok");

    try {
      await connections.ingest(binding, parsed.message);
    } catch (err) {
      // Persist failed → ask the platform to retry rather than acking a message
      // that is not on disk.
      log.warn(`[callback] ${adapter.platform} acceptance failed, asking the platform to retry: ${err.message}`);
      return res.status(503).json({ error: "temporarily unavailable" });
    }
    res.status(200).send("ok");
  };

  app.post("/v1/callbacks/:platform/:secret", express.raw({ type: "*/*", limit: "2mb" }), callbackHandler);
  app.get("/v1/callbacks/:platform/:secret", callbackHandler);

  return app;
}