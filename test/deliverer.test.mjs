// Subscriber delivery: backoff, eventual failure, and the confirmation rule.
// The caller's 2xx is the only confirmation; everything else is "not delivered".
import test from "node:test";
import assert from "node:assert/strict";
import { createDeliverer } from "../src/deliverer.js";

const quiet = { warn() {}, info() {} };

test("a subscriber that fails once then succeeds gets one delivery", async () => {
  let calls = 0;
  const statuses = [];
  const d = createDeliverer({
    timeoutMs: 200,
    maxAttempts: 3,
    log: quiet,
    fetchImpl: async () => {
      calls += 1;
      statuses.push(calls);
      return calls === 1 ? new Response("boom", { status: 500 }) : new Response("ok", { status: 200 });
    },
  });
  const attempts = [];
  const r = await d.deliver({
    envelope: { text: "x" },
    subscriberUrl: "http://sub.test/h",
    deliveryToken: "t",
    onAttempt: (a) => attempts.push(a),
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(calls, 2);
  assert.deepEqual(attempts.map((a) => a.ok), [false, true], "both attempts must be observable");
});

test("a permanently failing subscriber is marked failed, not retried forever", async () => {
  let calls = 0;
  const d = createDeliverer({
    timeoutMs: 200,
    maxAttempts: 3,
    log: quiet,
    fetchImpl: async () => {
      calls += 1;
      return new Response("nope", { status: 503 });
    },
  });
  const r = await d.deliver({ envelope: {}, subscriberUrl: "http://sub.test/h", deliveryToken: "t" });
  assert.equal(r.ok, false);
  assert.equal(calls, 3, "exactly maxAttempts calls, no more");
  assert.equal(r.status, 503);
});

test("a non-2xx is never treated as delivered, even with a 2xx-looking body", async () => {
  const d = createDeliverer({
    timeoutMs: 200,
    maxAttempts: 1,
    log: quiet,
    fetchImpl: async () => new Response('{"ok":true}', { status: 500 }),
  });
  const r = await d.deliver({ envelope: {}, subscriberUrl: "http://sub.test/h", deliveryToken: "t" });
  assert.equal(r.ok, false);
});

test("a hung subscriber times out and counts as failure", async () => {
  const d = createDeliverer({
    timeoutMs: 50,
    maxAttempts: 1,
    log: quiet,
    fetchImpl: (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
  });
  const r = await d.deliver({ envelope: {}, subscriberUrl: "http://sub.test/h", deliveryToken: "t" });
  assert.equal(r.ok, false);
});

test("the delivery token travels as a bearer, never in the body", async () => {
  let seen = null;
  const d = createDeliverer({
    timeoutMs: 200,
    maxAttempts: 1,
    log: quiet,
    fetchImpl: async (url, init) => {
      seen = init;
      return new Response("ok", { status: 200 });
    },
  });
  await d.deliver({ envelope: { text: "hi" }, subscriberUrl: "http://sub.test/h", deliveryToken: "tok-1" });
  assert.equal(seen.headers.authorization, "Bearer tok-1");
  assert.ok(!JSON.stringify(JSON.parse(seen.body)).includes("tok-1"));
});
