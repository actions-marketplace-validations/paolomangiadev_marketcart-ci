-- MarketCart CI entitlement ledger. SQLite dialect, compatible with Cloudflare D1.
-- Every multi-statement operation is written so each statement is conditional: the group is correct when run
-- as one transaction (local BEGIN IMMEDIATE) or one D1 batch, including replays and duplicate callbacks.
-- No raw license keys, buyer emails or IP addresses are stored.

CREATE TABLE IF NOT EXISTS grants (
  license_hash   TEXT PRIMARY KEY,            -- HMAC-SHA256(pepper, license key)
  product_link   TEXT NOT NULL,               -- Payhip product key the license belongs to
  credits_total  INTEGER NOT NULL,
  available      INTEGER NOT NULL CHECK (available >= 0),
  reserved       INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  consumed       INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  granted_at     INTEGER NOT NULL,            -- ms epoch = activation; validity runs from here
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoke_reason  TEXT,
  is_test        INTEGER NOT NULL DEFAULT 0,
  CHECK (available + reserved + consumed <= credits_total)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id          TEXT PRIMARY KEY,           -- client idempotency key
  license_hash    TEXT NOT NULL REFERENCES grants(license_hash),
  cases_reserved  INTEGER NOT NULL CHECK (cases_reserved > 0),
  state           TEXT NOT NULL CHECK (state IN ('reserved', 'completed')),
  applied         INTEGER NOT NULL DEFAULT 0, -- reservation applied to the wallet exactly once
  settled         INTEGER NOT NULL DEFAULT 0, -- completion applied to the wallet exactly once
  consumed        INTEGER NOT NULL DEFAULT 0,
  released        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  result_json     TEXT
);
CREATE INDEX IF NOT EXISTS jobs_open ON jobs(state, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_key       TEXT PRIMARY KEY,           -- "<type>:<transaction id>"
  type            TEXT NOT NULL,
  transaction_id  TEXT NOT NULL,
  received_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  transaction_id  TEXT PRIMARY KEY,
  product_link    TEXT NOT NULL,
  currency        TEXT NOT NULL,
  gross_minor     INTEGER NOT NULL,           -- Payhip "price" (cents)
  processor_fee_minor INTEGER,                -- Payhip "stripe_fee" when present (measured, not assumed)
  payhip_fee_minor    INTEGER,                -- Payhip "payhip_fee"
  paid_at         INTEGER NOT NULL,
  refunded_minor  INTEGER NOT NULL DEFAULT 0,
  refunded_at     INTEGER,
  is_test         INTEGER NOT NULL DEFAULT 0
);
