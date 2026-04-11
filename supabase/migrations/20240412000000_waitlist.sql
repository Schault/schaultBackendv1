-- Waitlist users table
CREATE TABLE waitlist_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  email text NOT NULL UNIQUE CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  phone text CHECK (phone IS NULL OR char_length(phone) BETWEEN 7 AND 20),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE waitlist_users ENABLE ROW LEVEL SECURITY;

-- No SELECT/UPDATE/DELETE policies — waitlist data is admin-only.
-- Only INSERT is allowed, and only for authenticated users (optional: remove auth check for public waitlist).
CREATE POLICY "Anyone can join waitlist" ON waitlist_users
  FOR INSERT WITH CHECK (true);

-- Index for duplicate-check lookups
CREATE INDEX idx_waitlist_users_email ON waitlist_users(email);
