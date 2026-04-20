-- Restore stock_quantity on product_variants when an order is cancelled.
-- Fires on ANY status transition to 'cancelled', covering both customer
-- self-service cancellation and admin cancellation via update-order-status.

CREATE OR REPLACE FUNCTION restore_stock_on_cancellation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only fire when the status is actually changing TO 'cancelled'
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    -- Restore stock for every line item in the cancelled order.
    -- Lock the variant rows (FOR UPDATE) to prevent concurrent stock
    -- modifications from racing with this restoration.
    UPDATE product_variants AS pv
    SET stock_quantity = pv.stock_quantity + oi.quantity
    FROM order_items oi
    WHERE oi.order_id = NEW.id
      AND pv.id = oi.variant_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Bind the trigger to fire AFTER the status column is updated on orders.
-- Using AFTER (not BEFORE) so the status change is committed and the
-- order_status_history trigger has already fired by this point.
DROP TRIGGER IF EXISTS restore_stock_on_cancel_trigger ON orders;
CREATE TRIGGER restore_stock_on_cancel_trigger
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION restore_stock_on_cancellation();
