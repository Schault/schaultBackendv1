-- Add 2 Products
INSERT INTO products (id, name, slug, description, base_price) VALUES
  ('550e8400-e29b-41d4-a716-446655440000', 'Schault Upper - Canvas', 'schault-upper-canvas', 'Breathable modular upper.', 899.00),
  ('660e8400-e29b-41d4-a716-446655440000', 'Schault Midsole - Cushion', 'schault-midsole-cushion', 'PU casted midsole for comfort.', 599.00);

-- Add Variants (Sizes)
INSERT INTO product_variants (product_id, size, color, sku, stock_quantity) VALUES
  ('550e8400-e29b-41d4-a716-446655440000', 'UK-8', 'Midnight Black', 'SCH-UPR-BLK-8', 50),
  ('550e8400-e29b-41d4-a716-446655440000', 'UK-9', 'Midnight Black', 'SCH-UPR-BLK-9', 20),
  ('660e8400-e29b-41d4-a716-446655440000', 'UK-8', 'White', 'SCH-MID-WHT-8', 100);
