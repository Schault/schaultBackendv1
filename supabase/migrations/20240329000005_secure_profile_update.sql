-- Drop the existing UPDATE policy that might allow role escalation
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;

-- Revoke UPDATE permission on the role column for authenticated users
-- This prevents self-escalation natively without relying on complex RLS
REVOKE UPDATE (role) ON profiles FROM authenticated;

-- Create a simple UPDATE policy
CREATE POLICY "Users can update own profile" ON profiles 
FOR UPDATE 
USING ((select auth.uid()) = id);
