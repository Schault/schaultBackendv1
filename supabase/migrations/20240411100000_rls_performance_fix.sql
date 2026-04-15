-- RLS PERFORMANCE FIX
-- Wrapping auth.uid() in (select auth.uid()) prevents PostgreSQL from
-- re-evaluating the function for every row, turning an O(n) call into O(1).
-- Each policy is dropped and recreated to ensure backward compatibility.

BEGIN;

-- PROFILES
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING ((select auth.uid()) = id);

-- CART_ITEMS
DROP POLICY IF EXISTS "Users manage own cart" ON cart_items;
CREATE POLICY "Users manage own cart" ON cart_items
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ORDERS
DROP POLICY IF EXISTS "Users view own orders" ON orders;
CREATE POLICY "Users view own orders" ON orders
  FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users create own orders" ON orders;
CREATE POLICY "Users create own orders" ON orders
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

-- ORDER_ITEMS
DROP POLICY IF EXISTS "Users view own order items" ON order_items;
CREATE POLICY "Users view own order items" ON order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_items.order_id
        AND orders.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users create order items" ON order_items;
CREATE POLICY "Users create order items" ON order_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_items.order_id
        AND orders.user_id = (select auth.uid())
    )
  );

-- ORDER_STATUS_HISTORY
DROP POLICY IF EXISTS "Users view own order history" ON order_status_history;
CREATE POLICY "Users view own order history" ON order_status_history
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_status_history.order_id
        AND orders.user_id = (select auth.uid())
    )
  );

COMMIT;
