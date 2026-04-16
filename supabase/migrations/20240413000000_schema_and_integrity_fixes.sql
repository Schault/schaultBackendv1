-- Addresses: INT-1 through INT-5, PERF-4, SCHEMA-1 through SCHEMA-5


-- INT-1 + INT-5: Atomic order status transition function
-- Replaces the race-prone read/write/fetch/update flow in the Edge Function
-- with a single PL/pgSQL function that uses SELECT ... FOR UPDATE.

CREATE OR REPLACE FUNCTION transition_order_status(
  p_order_id uuid,
  p_new_status text,
  p_note text DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status text;
  v_allowed text[];
  v_history_id uuid;
BEGIN
  SELECT status INTO v_current_status
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_current_status IS NULL THEN
    RETURN json_build_object('error', 'Order not found');
  END IF;

  v_allowed := CASE v_current_status
    WHEN 'pending'          THEN ARRAY['confirmed','cancelled']
    WHEN 'confirmed'        THEN ARRAY['processing','cancelled']
    WHEN 'processing'       THEN ARRAY['shipped','cancelled']
    WHEN 'shipped'          THEN ARRAY['out_for_delivery','cancelled']
    WHEN 'out_for_delivery' THEN ARRAY['delivered','cancelled']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (p_new_status = ANY(v_allowed)) THEN
    RETURN json_build_object(
      'error', format('Invalid transition: %s → %s', v_current_status, p_new_status)
    );
  END IF;

  UPDATE orders SET status = p_new_status WHERE id = p_order_id;

  -- The trigger has already fired and inserted a history row.
  -- Update it with the note atomically (same transaction).
  IF p_note IS NOT NULL THEN
    UPDATE order_status_history
    SET note = p_note
    WHERE id = (
      SELECT id FROM order_status_history
      WHERE order_id = p_order_id
        AND status = p_new_status
        AND note IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    );
  END IF;

  RETURN json_build_object('status', 'ok', 'previous_status', v_current_status);
END;
$$;


-- INT-3: Make order_items.line_total a generated column

ALTER TABLE order_items DROP COLUMN line_total;
ALTER TABLE order_items ADD COLUMN line_total numeric(10,2)
  GENERATED ALWAYS AS (unit_price * quantity) STORED;


-- INT-4: Validate orders.total matches SUM(order_items.line_total)

CREATE OR REPLACE FUNCTION validate_order_total()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT order_id FROM new_items
  LOOP
    PERFORM 1
    FROM (
      SELECT o.total AS order_total,
             COALESCE(SUM(oi.line_total), 0) AS items_sum
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id = r.order_id
      GROUP BY o.total
    ) sub
    WHERE sub.order_total IS DISTINCT FROM sub.items_sum;

    IF FOUND THEN
      RAISE EXCEPTION 'Order total mismatch for order %: orders.total does not equal SUM(order_items.line_total)',
        r.order_id;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS validate_order_total_trigger ON order_items;
CREATE TRIGGER validate_order_total_trigger
  AFTER INSERT ON order_items
  REFERENCING NEW TABLE AS new_items
  FOR EACH STATEMENT EXECUTE FUNCTION validate_order_total();


-- PERF-4: Denormalize user_id onto order_items & order_status_history

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES profiles(id);

ALTER TABLE order_status_history
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES profiles(id);

-- Backfill from parent orders table
UPDATE order_items oi
SET user_id = o.user_id
FROM orders o
WHERE o.id = oi.order_id
  AND oi.user_id IS NULL;

UPDATE order_status_history osh
SET user_id = o.user_id
FROM orders o
WHERE o.id = osh.order_id
  AND osh.user_id IS NULL;

-- Make NOT NULL after backfill
ALTER TABLE order_items
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE order_status_history
  ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_user_id
  ON order_items(user_id);

CREATE INDEX IF NOT EXISTS idx_order_status_history_user_id
  ON order_status_history(user_id);

-- Replace RLS policies with direct user_id checks
DROP POLICY IF EXISTS "Users view own order items" ON order_items;
CREATE POLICY "Users view own order items" ON order_items
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users view own order history" ON order_status_history;
CREATE POLICY "Users view own order history" ON order_status_history
  FOR SELECT USING (auth.uid() = user_id);


-- INT-2 + PERF-4: log_order_status_change → SECURITY INVOKER + user_id
-- Final version: includes user_id denormalization and SECURITY INVOKER fix.

CREATE OR REPLACE FUNCTION log_order_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO order_status_history (order_id, user_id, status)
    VALUES (NEW.id, NEW.user_id, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;


-- PERF: Add item_count to orders

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS item_count int NOT NULL DEFAULT 0;

UPDATE orders o
SET item_count = (
  SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id
)
WHERE item_count = 0;


-- SCHEMA-1: orders.user_id ON DELETE RESTRICT

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_user_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT;


-- SCHEMA-2: Prevent negative order totals

ALTER TABLE orders ADD CONSTRAINT orders_total_positive CHECK (total >= 0);


-- SCHEMA-3: Prevent negative unit_price and line_total

ALTER TABLE order_items
  ADD CONSTRAINT order_items_unit_price_positive CHECK (unit_price >= 0);

ALTER TABLE order_items
  ADD CONSTRAINT order_items_line_total_positive CHECK (line_total >= 0);


-- SCHEMA-4: Restrict profile roles + prevent self-escalation

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'profiles_role_check'
  ) THEN
    ALTER TABLE profiles
    ADD CONSTRAINT profiles_role_check CHECK (role IN ('customer', 'admin'));
  END IF;
END $$;

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id AND role = 'customer');


-- SCHEMA-5: Composite index for order pagination

CREATE INDEX IF NOT EXISTS idx_orders_user_created
  ON orders(user_id, created_at DESC);

DROP INDEX IF EXISTS idx_orders_user_id;
