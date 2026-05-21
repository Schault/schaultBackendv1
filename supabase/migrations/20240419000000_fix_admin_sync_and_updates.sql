-- ============================================================
-- MIGRATION: fix_admin_sync_and_updates
-- PURPOSE:   Fix two issues preventing admin panel updates:
--
--   1. app_metadata.role was never set for admins whose role was
--      assigned via INSERT (not UPDATE). The sync trigger only
--      fires on UPDATE OF role, so the edge function's
--      `app_metadata?.role === 'admin'` check returns 403.
--
--   2. Backfill all existing admin users so their auth.users
--      record has the correct app_metadata.role.
--
--   3. Extend the trigger to also fire on INSERT so future
--      admin profiles created via seed or direct SQL are synced.
--
--   4. Add admin UPDATE policy on orders table so the
--      transition_order_status RPC can update order status.
-- ============================================================


-- 1. BACKFILL: Sync existing admin roles to auth.users.app_metadata
-- This is a one-time fix for admins who were inserted with role='admin'
-- but whose app_metadata was never updated.
UPDATE auth.users u
SET raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', p.role)
FROM public.profiles p
WHERE u.id = p.id
  AND p.role = 'admin'
  AND (u.raw_app_meta_data ->> 'role') IS DISTINCT FROM 'admin';


-- 2. REPLACE the sync function to handle both INSERT and UPDATE
CREATE OR REPLACE FUNCTION sync_role_to_auth_users()
RETURNS TRIGGER AS $$
BEGIN
  -- On INSERT: always sync the role
  -- On UPDATE: only sync if role actually changed
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role) THEN
    UPDATE auth.users
    SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', NEW.role)
    WHERE id = NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;


-- 3. RECREATE the trigger to fire on both INSERT and UPDATE
DROP TRIGGER IF EXISTS on_profile_role_change ON public.profiles;
CREATE TRIGGER on_profile_role_change
  AFTER INSERT OR UPDATE OF role ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION sync_role_to_auth_users();


-- 4. Admin UPDATE policy on orders (needed by transition_order_status RPC)
-- The RPC function is SECURITY DEFINER so it bypasses RLS, but this is
-- good defense-in-depth in case the function is ever changed.
CREATE POLICY "Admin can update all orders" ON orders
  FOR UPDATE USING (is_admin());
