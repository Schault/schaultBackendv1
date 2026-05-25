-- ============================================================
-- MIGRATION: sync_role_trigger
-- PURPOSE:   Automatically synchronizes the `role` column in 
--            `public.profiles` with `auth.users.app_metadata`.
--            This ensures Edge Functions checking `app_metadata`
--            stay in sync when a role is updated via the Dashboard.
-- ============================================================

-- 1. Create the function that updates auth.users
-- We use SECURITY DEFINER so it runs with elevated privileges
-- and can write to the auth schema.
CREATE OR REPLACE FUNCTION sync_role_to_auth_users()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if the role was actually changed to avoid unnecessary updates
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    UPDATE auth.users
    SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', NEW.role)
    WHERE id = NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- 2. Attach the trigger to the profiles table
-- It will fire after any UPDATE that changes the 'role' column
DROP TRIGGER IF EXISTS on_profile_role_change ON public.profiles;
CREATE TRIGGER on_profile_role_change
  AFTER UPDATE OF role ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION sync_role_to_auth_users();
