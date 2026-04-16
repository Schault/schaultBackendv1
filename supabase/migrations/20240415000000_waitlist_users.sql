-- ============================================================
-- MIGRATION: waitlist_users
-- PURPOSE:   Public waitlist signup table for the coming-soon page.
--            Allows unauthenticated inserts so visitors can
--            join the waitlist before auth is available.
-- ============================================================

-- 1. CREATE TABLE (idempotent)
CREATE TABLE IF NOT EXISTS waitlist_users (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  email      text        NOT NULL,
  phone      text,
  created_at timestamptz NOT NULL    DEFAULT now()
);

-- 2. UNIQUE CONSTRAINT on email (idempotent via IF NOT EXISTS check)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'waitlist_users_email_key'
  ) THEN
    ALTER TABLE waitlist_users
      ADD CONSTRAINT waitlist_users_email_key UNIQUE (email);
  END IF;
END $$;

-- 3. INDEX on email for fast duplicate lookups (idempotent)
CREATE INDEX IF NOT EXISTS idx_waitlist_users_email
  ON waitlist_users (email);

-- 4. ENABLE ROW LEVEL SECURITY
ALTER TABLE waitlist_users ENABLE ROW LEVEL SECURITY;

-- 5. RLS POLICY — allow public (unauthenticated) inserts
DROP POLICY IF EXISTS "Allow public insert" ON waitlist_users;
CREATE POLICY "Allow public insert"
  ON waitlist_users
  FOR INSERT
  TO anon
  WITH CHECK (true);
