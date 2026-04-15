-- 1. PROFILES (Linked to auth.users)
CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  role text NOT NULL DEFAULT 'customer',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (new.id, new.raw_user_meta_data->>'full_name');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- 2. PRODUCTS
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  base_price numeric(10,2) NOT NULL CHECK (base_price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. PRODUCT VARIANTS
CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size text NOT NULL,
  color text,
  sku text NOT NULL UNIQUE,
  stock_quantity int NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, size, color)
);

-- 4. CART ITEMS
CREATE TABLE cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, variant_id)
);

-- 5. ORDERS
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id),
  status text NOT NULL DEFAULT 'pending',
  total numeric(10,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 6. ORDER ITEMS
CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  unit_price numeric(10,2) NOT NULL, -- snapshot of price at purchase
  quantity int NOT NULL CHECK (quantity > 0),
  line_total numeric(10,2) NOT NULL
);

-- RLS POLICIES --

-- Enable RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can only see and edit their own profile
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING ((select auth.uid()) = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING ((select auth.uid()) = id);

-- Products & Variants: Publicly readable, writeable only via dashboard (no policy = secure by default)
CREATE POLICY "Anyone can view active products" ON products FOR SELECT USING (is_active = true);
CREATE POLICY "Anyone can view variants" ON product_variants FOR SELECT USING (true);

-- Cart: Users can only see, add, update, delete their own cart items
CREATE POLICY "Users manage own cart" ON cart_items FOR ALL USING ((select auth.uid()) = user_id);

-- Orders: Users can only view their own orders.
-- INSERT is intentionally omitted — orders are created exclusively by the checkout
-- edge function via a direct postgres connection (bypasses RLS).
CREATE POLICY "Users view own orders" ON orders FOR SELECT USING ((select auth.uid()) = user_id);

-- Order Items: Users can view items if they own the parent order
CREATE POLICY "Users view own order items" ON order_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM orders WHERE orders.id = order_items.order_id AND orders.user_id = (select auth.uid()))
);

-- INSERT is intentionally omitted — order items are created exclusively by the
-- checkout edge function via a direct postgres connection (bypasses RLS).
-- PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_cart_items_variant_id ON cart_items(variant_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_variant_id ON order_items(variant_id);
