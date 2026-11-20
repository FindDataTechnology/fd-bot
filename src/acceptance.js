// Durable acceptance queue: accept (atomic file) → ack the platform → dispatch.
//
// Ported from paas `server/bot-acceptance.js` (the semantics there were learned
// in production; the three states are its contract). What changed is the key:
// `bindingId + platformMessageId` instead of `botId + platform msgid`, and the
// state machine's terminal action is "deliver an envelope", not "run a turn".
//
// Why disk-first: a pod roll between ack and delivery used to lose the message
// silently. Persisting BEFORE answering the platform means the platform either
// gets a failure (and retries) or the message is on disk.
//
// A record survives a crash in one of three states, each mapped to an honest
// startup action:
//   pending    — never dispatched             → deliver it (replay)
//   dispatched — delivery had started          → mark done, outcome unknown
//                (re-delivering risks a duplicate envelope; the in-flight
//                delivery is the honest gap, same as every killed request)
//   done       — settled (or duplicate)        → retention window, then cleanup
import { readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;

export function createAcceptance({ dir, now = Date.now, maxRecords = Number(process.env.FD_BOT_ACCEPTANCE_MAX) || 5000 }) {
  const root = dir ?? path.join(process.cwd(), "data", "acceptance");
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });

  const records = new Map(); // id -> record
  const keys = new Map(); // dedupe key -> id

  const fileOf = (id) => path.join(root, `${id}.json`);
  const tmpOf = (id) => path.join(root, `.${id}.${crypto.randomBytes(4).toString("hex")}.tmp`);

  function write(rec) {
    const tmp = tmpOf(rec.id);
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, fileOf(rec.id));
    records.set(rec.id, rec);
    if (rec.key) keys.set(rec.key, rec.id);
  }

  function makeId() {
    return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
  }

  function load() {
    let entries = [];
    try {
      entries = readdirSync(root).filter((f) => f.endsWith(".json"));
    } catch {
      return { loaded: 0, expired: 0 };
    }
    let loaded = 0;
    let expired = 0;
    const cut = now() - DONE_RETENTION_MS;
    for (const f of entries) {
      try {
        const rec = JSON.parse(readFileSync(path.join(root, f), "utf8"));
        if (rec.state === "done" && (rec.doneAt ?? rec.receivedAt) < cut) {
          rmSync(path.join(root, f), { force: true });
          expired += 1;
          continue;
        }
        records.set(rec.id, rec);
        if (rec.key) keys.set(rec.key, rec.id);
        loaded += 1;
      } catch {
        // A torn file is not an acceptance record; remove it so counts stay honest.
        rmSync(path.join(root, f), { force: true });
      }
    }
    return { loaded, expired };
  }

  /**
   * Accept one inbound item. `rec` = { bindingId, key?, payload?, envelope? }.
   * Returns { record, duplicate }. duplicate=true means the key was already
   * live: a done/duplicate note is stored (observable) and the caller MUST NOT
   * deliver again.
   */
  function accept(rec) {
    if (records.size >= maxRecords) {
      const err = new Error(`acceptance store full (${maxRecords} live records)`);
      err.code = "ACCEPTANCE_FULL";
      throw err;
    }
    const id = makeId();
    const record = { id, state: "pending", receivedAt: now(), ...rec };
    if (rec.key && keys.has(rec.key)) {
      const dup = { ...record, state: "done", note: "duplicate", doneAt: now() };
      write(dup);
      return { record: dup, duplicate: true };
    }
    write(record);
    return { record, duplicate: false };
  }

  const NEXT_STATE = {
    pending: new Set(["dispatched", "done"]),
    dispatched: new Set(["done"]),
    done: new Set(),
  };

  function transition(id, state, note = null) {
    const rec = records.get(id);
    if (!rec || !NEXT_STATE[rec.state]?.has(state)) return null;
    const next = { ...rec, state, note: note ?? rec.note ?? null, ...(state === "done" ? { doneAt: now() } : {}) };
    write(next);
    return next;
  }

  const markDispatched = (id) => transition(id, "dispatched");
  const markDone = (id, note = null) => transition(id, "done", note);
  const markFailed = (id, note) => transition(id, "done", note ? `failed: ${note}` : "failed");

  const pending = () => [...records.values()].filter((r) => r.state === "pending");
  const all = () => [...records.values()];
  const byId = (id) => records.get(id) ?? null;

  function cleanup() {
    const cut = now() - DONE_RETENTION_MS;
    let removed = 0;
    for (const rec of [...records.values()]) {
      if (rec.state === "done" && (rec.doneAt ?? rec.receivedAt) < cut) {
        records.delete(rec.id);
        if (rec.key && keys.get(rec.key) === rec.id) keys.delete(rec.key);
        rmSync(fileOf(rec.id), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  load();

  return { root, load, accept, markDispatched, markDone, markFailed, pending, all, byId, cleanup };
}