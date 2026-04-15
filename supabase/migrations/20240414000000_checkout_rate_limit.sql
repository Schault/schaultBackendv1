-- Per-user checkout rate limiting (sliding window)
-- Prevents stock-draining attacks by limiting checkout frequency.

-- 1. Rate limit tracking table
-- One row per checkout attempt. Only user_id + timestamp needed.

CREATE TABLE checkout_rate_limit (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for efficient sliding-window COUNT queries
CREATE INDEX idx_checkout_rate_limit_user_created
  ON checkout_rate_limit(user_id, created_at DESC);

-- RLS enabled but no user-facing policies — this table is only
-- accessed by the checkout Edge Function via direct Postgres connection.
ALTER TABLE checkout_rate_limit ENABLE ROW LEVEL SECURITY;


-- 2. Atomic rate-limit check + record function
-- Returns JSON: { "allowed": true } or { "allowed": false, "retry_after_seconds": N }

CREATE OR REPLACE FUNCTION check_checkout_rate_limit(
  p_user_id        uuid,
  p_max_attempts   int DEFAULT 5,
  p_window_minutes int DEFAULT 15
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start timestamptz;
  v_attempt_count int;
  v_oldest_in_window timestamptz;
  v_retry_after int;
BEGIN
  -- Obtain an exclusive lock for this user's rate limit check to prevent concurrent bypasses
  -- The lock is automatically released at the end of the transaction (function execution).
  PERFORM pg_advisory_xact_lock(hashtext('checkout_rate_limit_' || p_user_id::text));

  v_window_start := now() - (p_window_minutes || ' minutes')::interval;

  -- Count attempts within the sliding window
  SELECT COUNT(*), MIN(created_at)
  INTO v_attempt_count, v_oldest_in_window
  FROM checkout_rate_limit
  WHERE user_id = p_user_id
    AND created_at > v_window_start;

  -- Over limit → reject with retry hint
  IF v_attempt_count >= p_max_attempts THEN
    -- Seconds until the oldest attempt falls out of the window
    v_retry_after := GREATEST(
      1,
      EXTRACT(EPOCH FROM (v_oldest_in_window + (p_window_minutes || ' minutes')::interval - now()))::int
    );

    RETURN json_build_object(
      'allowed', false,
      'retry_after_seconds', v_retry_after
    );
  END IF;

  -- Under limit → record this attempt and allow
  INSERT INTO checkout_rate_limit (user_id) VALUES (p_user_id);

  RETURN json_build_object('allowed', true);
END;
$$;


-- 3. Cleanup function for expired rate-limit records
-- Deletes records older than 1 hour (generous buffer over the 15-min window).
-- Call via pg_cron or the same sweep that cleans idempotency_keys.

CREATE OR REPLACE FUNCTION cleanup_stale_checkout_rate_limits()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM checkout_rate_limit
  WHERE created_at < now() - interval '1 hour';
END;
$$;
