-- ============================================================
-- MIGRATION: admin_select_policies
-- PURPOSE:   Grant admin users SELECT access to tables queried
--            by the admin panel. Without these, RLS silently
--            returns empty arrays for admin queries.
-- DEPENDS:   is_admin() helper from 20240329000004_admin_rls.sql
-- ============================================================

-- Orders: admins need to see all orders, not just their own
CREATE POLICY "Admin can view all orders" ON orders
  FOR SELECT USING (is_admin());

-- Order items: admins need to see items across all orders
CREATE POLICY "Admin can view all order items" ON order_items
  FOR SELECT USING (is_admin());

-- Order status history: admins need full lifecycle visibility
CREATE POLICY "Admin can view all order history" ON order_status_history
  FOR SELECT USING (is_admin());

-- Waitlist: only public INSERT exists, admins need SELECT
CREATE POLICY "Admin can view all waitlist users" ON waitlist_users
  FOR SELECT USING (is_admin());

-- Profiles: admins need to read customer names for order joins
CREATE POLICY "Admin can view all profiles" ON profiles
  FOR SELECT USING (is_admin());
