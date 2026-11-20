// Durable acceptance: the three states, the duplicate rule, and the honest
// no-key path. Each assertion maps to a spec scenario.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcceptance } from "../src/acceptance.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "fd-bot-acc-"));

test("accepted record is on disk before it is dispatched", () => {
  const dir = tmp();
  try {
    const acc = createAcceptance({ dir });
    acc.accept({ bindingId: "b1", key: "k1", payload: { text: "hi" } });
    // A fresh instance == what a restarting process sees.
    const reopened = createAcceptance({ dir });
    const pending = reopened.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, "pending");
    assert.deepEqual(pending[0].payload, { text: "hi" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate platform id is confirmed, not delivered again", () => {
  const dir = tmp();
  try {
    const acc = createAcceptance({ dir });
    const first = acc.accept({ bindingId: "b1", key: "b1:msg1", payload: {} });
    assert.equal(first.duplicate, false);
    const second = acc.accept({ bindingId: "b1", key: "b1:msg1", payload: {} });
    assert.equal(second.duplicate, true);
    assert.equal(second.record.note, "duplicate");
    // Only one pending delivery exists.
    assert.equal(acc.pending().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a payload with no platform id gets no invented key", () => {
  const dir = tmp();
  try {
    const acc = createAcceptance({ dir });
    const a = acc.accept({ bindingId: "b1", key: null, payload: { text: "x" } });
    const b = acc.accept({ bindingId: "b1", key: null, payload: { text: "x" } });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, false, "two keyless payloads must both be delivered, never deduped by guess");
    assert.equal(acc.pending().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state machine is one-way and terminal", () => {
  const dir = tmp();
  try {
    const acc = createAcceptance({ dir });
    const { record } = acc.accept({ bindingId: "b1", key: "k", payload: {} });
    acc.markDispatched(record.id);
    acc.markDone(record.id, "ok");
    assert.equal(acc.byId(record.id).state, "done");
    assert.equal(acc.markDispatched(record.id), null, "done cannot go back to dispatched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn file is discarded rather than counted", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "junk.json"), "{not json");
    const acc = createAcceptance({ dir });
    assert.equal(acc.all().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a full store refuses rather than dropping silently", () => {
  const dir = tmp();
  try {
    const acc = createAcceptance({ dir, maxRecords: 1 });
    acc.accept({ bindingId: "b1", key: "k1", payload: {} });
    assert.throws(() => acc.accept({ bindingId: "b1", key: "k2", payload: {} }), /full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
