// Binding store: memory (dev/test) and Postgres (deployment).
//
// Public shape of a stored binding, as the API layer sees it:
//   { id, platform, credentials(encrypted blob), subscriberUrl, deliveryToken,
//     inboundMode, label, createdAt, disabledAt }
//
// `toPublic()` is the ONLY function that turns a row into a response body, and
// it deliberately drops the credential blob and the delivery token. Keeping one
// such function is what makes "credentials never leave the service" greppable.
import { newId, newToken } from "./ids.js";
import { encryptCredentials, decryptCredentials } from "./credentials.js";

export function toPublic(row, { adapter = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    label: row.label ?? null,
    inboundMode: row.inboundMode,
    // Shape only: which fields the operator has filled in. Never values.
    credentials: { configured: Object.keys(row.credentials).filter((k) => String(row.credentials[k] ?? "").trim()) },
    outbound: adapter ? { mode: adapter.outbound.mode, inbound: adapter.outbound.inbound } : null,
    inboundModes: adapter?.inboundModes ?? [],
    createdAt: row.createdAt,
    disabledAt: row.disabledAt ?? null,
  };
}

function shape({ id, platform, credentials, subscriberUrl, deliveryToken, inboundMode, label, createdAt, disabledAt }) {
  return { id, platform, credentials, subscriberUrl, deliveryToken, inboundMode, label: label ?? null, createdAt, disabledAt: disabledAt ?? null };
}

export function createMemoryStore() {
  const rows = new Map();
  return {
    kind: "memory",
    async migrate() {},
    async create({ platform, credentials, subscriberUrl, inboundMode, label, credentialKey }) {
      const row = shape({
        id: newId("b"),
        platform,
        credentials: encryptCredentials(credentialKey, credentials),
        subscriberUrl,
        deliveryToken: newToken(),
        inboundMode,
        label,
        createdAt: Date.now(),
      });
      rows.set(row.id, row);
      return row;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()].filter((r) => !r.disabledAt);
    },
    async disable(id) {
      const row = rows.get(id);
      if (!row) return false;
      row.disabledAt = Date.now();
      return true;
    },
    async close() {},
  };
}

export async function createPgStore({ connectionString, credentialKey, migrate = true }) {
  // Imported lazily so a dev run without the dependency installed still starts
  // in memory mode instead of failing at module load.
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 5 });
  if (migrate) await runMigrations(pool);

  const rowOf = (r) =>
    shape({
      id: r.id,
      platform: r.platform,
      credentials: decryptCredentials(credentialKey, r.credentials),
      subscriberUrl: r.subscriber_url,
      deliveryToken: r.delivery_token,
      inboundMode: r.inbound_mode,
      label: r.label,
      createdAt: Number(r.created_at),
      disabledAt: r.disabled_at === null ? null : Number(r.disabled_at),
    });

  return {
    kind: "pg",
    async migrate() {
      await runMigrations(pool);
    },
    async create({ platform, credentials, subscriberUrl, inboundMode, label }) {
      const id = newId("b");
      const deliveryToken = newToken();
      await pool.query(
        `INSERT INTO fd_bot_bindings (id, platform, credentials, subscriber_url, delivery_token, inbound_mode, label, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, platform, encryptCredentials(credentialKey, credentials), subscriberUrl, deliveryToken, inboundMode, label ?? null, Date.now()],
      );
      return shape({ id, platform, credentials, subscriberUrl, deliveryToken, inboundMode, label, createdAt: Date.now() });
    },
    async get(id) {
      const { rows } = await pool.query("SELECT * FROM fd_bot_bindings WHERE id = $1", [id]);
      return rows.length ? rowOf(rows[0]) : null;
    },
    async list() {
      const { rows } = await pool.query("SELECT * FROM fd_bot_bindings WHERE disabled_at IS NULL ORDER BY created_at");
      return rows.map(rowOf);
    },
    async disable(id) {
      const { rowCount } = await pool.query(
        "UPDATE fd_bot_bindings SET disabled_at = $2 WHERE id = $1 AND disabled_at IS NULL",
        [id, Date.now()],
      );
      return rowCount > 0;
    },
    async close() {
      await pool.end();
    },
  };
}

async function runMigrations(pool) {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(path.join(here, "..", "migrations", "001-bindings.sql"), "utf8");
  await pool.query(sql);
}

export async function createStore(cfg) {
  if (cfg.databaseUrl) {
    return createPgStore({ connectionString: cfg.databaseUrl, credentialKey: cfg.credentialKey });
  }
  return createMemoryStore();
}
