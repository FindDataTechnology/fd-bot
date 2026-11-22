// Auto-reconnect on a long-connection drop (2026-11-22): a state-reporting
// transport that reports connected:false must trigger a re-dial with backoff —
// otherwise the leg stays dead until a pod restart (observed: WS kicked by a
// newer connection, every send then failing "WebSocket not connected").
import test from "node:test";
import assert from "node:assert/strict";
import { createConnectionManager } from "../src/connections.js";

process.env.FD_BOT_RECONNECT_BASE_MS = "10";
process.env.FD_BOT_RECONNECT_MAX_MS = "50";

function fakes() {
  let starts = 0;
  let lastState = null;
  const transport = {
    reportsState: true,
    startCount: () => starts,
    lastState: () => lastState,
    async start(onMessage, onStateChange) {
      starts += 1;
      onStateChange?.({ connected: true });
      transport._emit = onStateChange; // test drives drops
    },
    async stop() {},
    async sendText() {},
  };
  const adapter = {
    platform: "stub",
    outbound: { mode: "url-keyed", inbound: true },
    inboundModes: ["long-connection"],
    createTransport: () => transport,
  };
  const registry = { get: (p) => (p === "stub" ? adapter : null), all: () => [adapter], capabilities: () => [] };
  let disabled = false;
  const store = {
    async get(id) { return id === "b1" ? { id: "b1", platform: "stub", credentials: {}, subscriberUrl: "http://x/", deliveryToken: "t", callbackSecret: "c", inboundMode: "long-connection", disabledAt: disabled ? Date.now() : null } : null; },
    async list() { return [await store.get("b1")]; },
  };
  const noop = async () => {};
  const connections = createConnectionManager({
    store, registry,
    acceptance: { accept: () => ({ record: { id: "r" }, duplicate: false }), markDispatched: noop, markDone: noop, markFailed: noop },
    deliverer: { deliver: async () => ({ ok: true }) },
    buildEnvelope: () => ({}), tickets: { issueFor: () => "t" },
    log: { warn() {}, info() {} },
  });
  return { transport, store, connections, setDisabled: (d) => { disabled = d; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a reported drop triggers an automatic re-dial (backoff)", async () => {
  const { transport, connections, store } = fakes();
  await connections.startBinding(await store.get("b1"));
  assert.equal(transport.startCount(), 1, "started once");
  // Simulate the server kicking us.
  transport._emit({ connected: false, error: "disconnected: New connection established" });
  await sleep(60);
  assert.ok(transport.startCount() >= 2, `re-dialed after drop (started ${transport.startCount()}x)`);
  await connections.stopAll();
});

test("a disabled binding is NOT reconnected", async () => {
  const { transport, store, connections, setDisabled } = fakes();
  const b1 = await store.get("b1");
  await connections.startBinding(b1);
  const before = transport.startCount();
  setDisabled(true);
  transport._emit({ connected: false, error: "drop" });
  await sleep(60);
  assert.equal(transport.startCount(), before, "no re-dial for a disabled binding");
  await connections.stopAll();
});

test("stop clears any pending reconnect (no dial after stop)", async () => {
  const { transport, connections, store } = fakes();
  await connections.startBinding(await store.get("b1"));
  transport._emit({ connected: false, error: "drop" });
  await connections.stopBinding("b1"); // before the backoff fires
  const afterStop = transport.startCount();
  await sleep(60);
  assert.equal(transport.startCount(), afterStop, "no dial after explicit stop");
});
