-- fd-bot bindings. The only durable state besides the acceptance queue.
-- Applied by `npm run migrate` (src/migrate.js) or by the service at boot.

CREATE TABLE IF NOT EXISTS fd_bot_bindings (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  -- AES-256-GCM blob (credentials.js). Never selected by a route verbatim:
  -- the read path returns {configured:[...]} and nothing else.
  credentials     TEXT NOT NULL,
  subscriber_url  TEXT NOT NULL,
  -- Secret the subscriber is called with (never leaves the service).
  delivery_token  TEXT NOT NULL,
  -- Secret baked into the PUBLIC callback URL the operator pastes into the
  -- platform console. A different secret on purpose: knowing where to deliver
  -- inbound must not let anyone forge envelopes to the subscriber.
  callback_secret TEXT NOT NULL,
  inbound_mode    TEXT NOT NULL,            -- 'callback' | 'long-connection'
  label           TEXT,
  created_at      BIGINT NOT NULL,
  disabled_at     BIGINT
);

-- Retired bindings are kept (audit trail) but never listed as active.
CREATE INDEX IF NOT EXISTS idx_fd_bot_bindings_active
  ON fd_bot_bindings (platform) WHERE disabled_at IS NULL;
