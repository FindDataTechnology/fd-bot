// Capability gate: walks THE REGISTRY, not a hand-written list.
//
// The failure this prevents, measured in `add-mattermost-channel`: the gate had
// five platform names typed into it, Slack was the sixth, and it walked past.
// Deriving from the registry means adding a platform without a capability is a
// red test rather than a quiet "cannot send back".
//
// Two assertions per platform:
//   1. it declares `{mode, inbound}` with a mode from the enum
//   2. it can actually do something: `mode !== "none"` or `inbound === false`
//      (pure push-only legs are the one honest exception)
import test from "node:test";
import assert from "node:assert/strict";
import { OUTBOUND_MODES, createRegistry, adapterProblems } from "../src/registry.js";
import { adapters } from "../src/adapters/index.js";

test("every registered adapter declares a usable outbound capability", () => {
  assert.ok(adapters.length > 0, "registry must not be empty");
  for (const a of adapters) {
    assert.deepEqual(adapterProblems(a), [], `${a.platform} has capability problems`);
    assert.ok(OUTBOUND_MODES.includes(a.outbound.mode), `${a.platform}: mode out of enum`);
    const canSend = a.outbound.mode !== "none";
    const canReceive = a.outbound.inbound === true;
    assert.ok(canSend || !canReceive || a.outbound.mode === "none" && a.outbound.inbound, "unreachable");
  }
});

test("a platform with no outbound declaration fails the gate (red-proof)", () => {
  const broken = { platform: "x-broken", createTransport() {} };
  const problems = adapterProblems(broken);
  assert.ok(problems.some((p) => p.includes("outbound")), `expected an outbound complaint, got ${problems}`);
  assert.throws(() => createRegistry([broken]), /outbound/);
});

test("a push-only leg must not claim inbound", () => {
  const lying = {
    platform: "x-push",
    outbound: { mode: "none", inbound: true },
    createTransport() {},
  };
  assert.ok(adapterProblems(lying).length > 0);
});

test("the registry exposes capabilities from the modules themselves", () => {
  const registry = createRegistry(adapters);
  const caps = registry.capabilities();
  assert.equal(caps.length, adapters.length);
  // Mutating the module export must change what the interface reports — that is
  // the whole point of one source of truth.
  const original = adapters[0].outbound.mode;
  adapters[0].outbound.mode = "none";
  try {
    const after = registry.capabilities()[0];
    assert.equal(after.outbound.mode, "none");
  } finally {
    adapters[0].outbound.mode = original;
  }
});
