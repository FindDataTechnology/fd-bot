// fd-bot configuration. Everything comes from env; nothing has a secret default.
//
// Failing loudly beats failing open: a missing media secret or credential key is
// a startup error, not a warning — a service that can sign tickets with a
// predictable key is worse than a service that is down.

const bool = (v, dflt) => (v === undefined ? dflt : ["1", "true", "yes"].includes(String(v).toLowerCase()));
const int = (v, dflt) => (v === undefined || v === "" ? dflt : Number(v));

export function loadConfig(env = process.env) {
  const dataDir = env.FD_BOT_DATA_DIR || "./data";
  return {
    port: int(env.PORT, 8791),
    host: env.HOST || "127.0.0.1",
    dataDir,
    databaseUrl: env.FD_BOT_DATABASE_URL || null,
    publicBaseUrl: (env.FD_BOT_PUBLIC_BASE_URL || "").replace(/\/+$/, "") || null,
    mediaSecret: env.FD_BOT_MEDIA_SECRET || "",
    // 调用面凭据（authenticate-send-endpoint）。**刻意不进 configProblems**：
    // 缺它不该阻止启动——/health 必须能答，否则运维看到的是「整个服务挂了」
    // 而不是「差一个 token」。受保护端点在缺失时回 503（见 app.js 的 apiAuth）。
    apiToken: env.FD_BOT_API_TOKEN || "",
    credentialKey: env.FD_BOT_CREDENTIAL_KEY || "",
    delivery: {
      timeoutMs: int(env.FD_BOT_DELIVERY_TIMEOUT_MS, 10_000),
      maxAttempts: int(env.FD_BOT_DELIVERY_MAX_ATTEMPTS, 8),
    },
    mediaTtlMs: int(env.FD_BOT_MEDIA_TTL_MS, 5 * 60_000),
    // A binding whose transport exists but whose platform has no real
    // implementation can be created for layout work; sending on it fails with
    // `other`+detail rather than pretending.
    allowStubTransports: bool(env.FD_BOT_ALLOW_STUB_TRANSPORTS, false),
  };
}

/**
 * Config problems that must stop the process. Returns [] when usable.
 * In-memory bindings are allowed only when explicitly acknowledged, because a
 * restart silently losing every binding is the kind of failure that looks like
 * "the platform stopped working".
 */
export function configProblems(cfg) {
  const out = [];
  if (!cfg.mediaSecret || cfg.mediaSecret.length < 16) {
    out.push("FD_BOT_MEDIA_SECRET must be set (>= 16 chars) — media tickets are signed with it");
  }
  if (!cfg.credentialKey || cfg.credentialKey.length < 16) {
    out.push("FD_BOT_CREDENTIAL_KEY must be set (>= 16 chars) — binding credentials are encrypted at rest");
  }
  return out;
}
