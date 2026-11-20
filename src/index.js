// Process entry: validate adapters, refuse to start on a capability hole,
// take over any pending acceptance records, start persisting connections.
//
// The two refusals at boot are deliberate and load-bearing:
//   • config problems (missing media/credential secrets) → exit non-zero
//   • an adapter that does not state a valid outbound capability → exit non-zero
// Both are "a service that cannot do its job must not pretend to run".
import http from "node:http";
import { loadConfig, configProblems } from "./config.js";
import { createRegistry } from "./registry.js";
import { createStore } from "./bindings.js";
import { createAcceptance } from "./acceptance.js";
import { createDeliverer } from "./deliverer.js";
import { createTickets, buildEnvelope } from "./envelope.js";
import { createConnectionManager } from "./connections.js";
import { createApp } from "./app.js";
import { adapters } from "./adapters/index.js";

const log = console;

const cfg = loadConfig();
const problems = configProblems(cfg);
if (problems.length) {
  for (const p of problems) log.error(`[config] ${p}`);
  process.exit(2);
}

let registry;
try {
  registry = createRegistry(adapters);
} catch (err) {
  log.error(`[registry] ${err.message}`);
  process.exit(3);
}

const store = await createStore(cfg);
const acceptance = createAcceptance({ dir: `${cfg.dataDir}/acceptance` });
const deliverer = createDeliverer({ timeoutMs: cfg.delivery.timeoutMs, maxAttempts: cfg.delivery.maxAttempts, log });
const tickets = createTickets(cfg);
const connections = createConnectionManager({
  store,
  registry,
  acceptance,
  deliverer,
  tickets,
  buildEnvelope,
  log,
});

// Takeover: anything accepted but never dispatched survives a restart and is
// delivered now. `dispatched` records are being settled already — re-running
// them would risk a duplicate envelope, so they are closed honestly.
const resumed = acceptance.pending();
for (const rec of resumed) {
  log.warn(`[boot] taking over ${resumed.length} pending acceptance record(s); delivering`);
  void (async () => {
    const row = await store.get(rec.bindingId);
    if (!row || row.disabledAt) return acceptance.markFailed(rec.id, "binding gone");
    const envelope = buildEnvelope({
      bindingId: row.id,
      platform: row.platform,
      message: rec.payload,
      tickets,
    });
    const result = await deliverer.deliver({
      envelope,
      subscriberUrl: row.subscriberUrl,
      deliveryToken: row.deliveryToken,
    });
    if (result.ok) acceptance.markDone(rec.id);
    else acceptance.markFailed(rec.id, `${result.status}`);
    acceptance.markDispatched(rec.id);
  })();
}
for (const rec of acceptance.all().filter((r) => r.state === "dispatched")) {
  acceptance.markDone(rec.id, "outcome unknown after restart");
}

await connections.startAll();

const app = createApp({ cfg, store, registry, connections, tickets, log });
const server = http.createServer(app);
server.listen(cfg.port, cfg.host, () => {
  log.log(`[fd-bot] listening on http://${cfg.host}:${cfg.port} (store=${store.kind}, platforms=${registry.all().length})`);
});

const shutdown = async (signal) => {
  log.log(`[fd-bot] ${signal} received; shutting down`);
  server.close();
  await connections.stopAll();
  await deliverer.drain().catch(() => {});
  await store.close?.();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));