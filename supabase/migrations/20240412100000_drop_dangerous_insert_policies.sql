-- CRIT-2 fix: Remove INSERT policy on orders.
-- Orders must only be created through the checkout edge function (which uses
-- a direct postgres connection, bypassing RLS). The previous policy allowed
-- any authenticated user to insert rows with arbitrary totals via PostgREST.
DROP POLICY IF EXISTS "Users create own orders" ON orders;

-- CRIT-3 fix: Remove INSERT policy on order_items.
-- Same rationale — order items are created exclusively by the checkout function.
-- The previous policy allowed users to fabricate order items at any price.
DROP POLICY IF EXISTS "Users create order items" ON order_items;
