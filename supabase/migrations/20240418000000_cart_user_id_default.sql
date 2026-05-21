-- Fix: Allow PostgREST cart inserts without explicitly passing user_id.
-- The RLS policy "Users manage own cart" checks (auth.uid() = user_id),
-- but without a DEFAULT the column is NULL on insert, failing the check.
-- Setting DEFAULT auth.uid() auto-fills the authenticated user's ID.

ALTER TABLE cart_items ALTER COLUMN user_id SET DEFAULT auth.uid();
