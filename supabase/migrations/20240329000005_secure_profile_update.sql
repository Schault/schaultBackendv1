-- Drop the existing UPDATE policy that might allow role escalation
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;

-- Create a new UPDATE policy with a secure WITH CHECK clause
-- This ensures users can't arbitrarily escalate their role to admin
CREATE POLICY "Users can update own profile" ON profiles 
FOR UPDATE 
USING (auth.uid() = id)
WITH CHECK (
  auth.uid() = id AND 
  role = 'customer'
);
