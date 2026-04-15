-- is_admin() helper function
CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = (select auth.uid()) AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- Admin policies for products
CREATE POLICY "Admin can insert products" ON products FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Admin can update products" ON products FOR UPDATE USING (is_admin());
CREATE POLICY "Admin can delete products" ON products FOR DELETE USING (is_admin());

-- Admin policies for product_variants
CREATE POLICY "Admin can insert product_variants" ON product_variants FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Admin can update product_variants" ON product_variants FOR UPDATE USING (is_admin());
CREATE POLICY "Admin can delete product_variants" ON product_variants FOR DELETE USING (is_admin());

-- Admin policies for categories (Commented out because table doesn't exist yet)
-- CREATE POLICY "Admin can insert categories" ON categories FOR INSERT WITH CHECK (is_admin());
-- CREATE POLICY "Admin can update categories" ON categories FOR UPDATE USING (is_admin());
-- CREATE POLICY "Admin can delete categories" ON categories FOR DELETE USING (is_admin());
