-- fd-bot bindings. The only durable state besides the acceptance queue.
-- Applied by `npm run migrate` (src/migrate.js) or by the service at boot.

CREATE TABLE IF NOT EXISTS fd_bot_bindings (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  -- AES-256-GCM blob (credentials.js). Never selected by a route verbatim:
  -- the read path returns {configured:[...]} and nothing else.
  credentials     TEXT NOT NULL,
  subscriber_url  TEXT NOT NULL,
  delivery_token  TEXT NOT NULL,
  inbound_mode    TEXT NOT NULL,            -- 'callback' | 'long-connection'
  label           TEXT,
  created_at      BIGINT NOT NULL,
  disabled_at     BIGINT
);

-- Retired bindings are kept (audit trail) but never listed as active.
CREATE INDEX IF NOT EXISTS idx_fd_bot_bindings_active
  ON fd_bot_bindings (platform) WHERE disabled_at IS NULL;
