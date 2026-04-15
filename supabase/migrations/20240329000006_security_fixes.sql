-- CRITICAL FIX: Ensure 'role' is restricted to valid values
-- Prevents privilege escalation bypasses from direct DB updates or Edge Functions.
ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('customer', 'admin'));
