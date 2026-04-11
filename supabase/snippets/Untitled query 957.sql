BEGIN;
  SET ROLE authenticated;
  
  -- Mock the Customer's JWT ID
  SET LOCAL request.jwt.claims = '{"sub": "c2222222-2222-2222-2222-222222222222"}';

  -- TEST: CREATE (Should FAIL with error 42501: insufficient_privilege)
  -- This confirms your Admin-only policy is working.
  -- INSERT INTO products (name, slug, base_price) 
  -- VALUES ('Illegal Item', 'illegal-item', 1.00);

  -- TEST: READ (Should SUCCEED for active products)
  SELECT name FROM products WHERE is_active = true;
ROLLBACK;