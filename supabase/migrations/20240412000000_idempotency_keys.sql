-- Idempotency keys table
-- Prevents duplicate checkout submissions (e.g. double-click on "Check Out").
-- Each row tracks a single checkout attempt keyed by (user_id, key_name).
-- The ON CONFLICT … DO UPDATE pattern serialises concurrent requests so that
-- only one actually performs the checkout; the other receives the cached response.

CREATE TABLE idempotency_keys (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    key_name             text        NOT NULL,
    response_body        jsonb,
    response_status_code int,
    locked_at            timestamptz NOT NULL DEFAULT now(),
    completed_at         timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, key_name)
);

-- The UNIQUE constraint already creates a btree index on (user_id, key_name).
-- An additional single-column index speeds up any user-scoped lookups / cleanup jobs.
CREATE INDEX idx_idempotency_keys_user_id ON idempotency_keys(user_id);

-- Automatic cleanup: expire stale keys older than 24 hours.
-- This keeps the table lean without manual intervention.
-- A pg_cron job or application-level sweep can call this periodically.
CREATE OR REPLACE FUNCTION cleanup_stale_idempotency_keys()
RETURNS void AS $$
BEGIN
    DELETE FROM idempotency_keys
    WHERE created_at < now() - interval '24 hours';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Row Level Security
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own idempotency keys"
    ON idempotency_keys FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own idempotency keys"
    ON idempotency_keys FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update own idempotency keys"
    ON idempotency_keys FOR UPDATE
    USING (auth.uid() = user_id);
