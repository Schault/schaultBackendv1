
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

//Types
interface CartRow {
  cart_item_id: string;
  variant_id: string;
  requested_qty: number;
  stock_quantity: number;
  base_price: string; // numeric comes back as string from pg
}

interface UserError {
  userError: true;
  status: number;
  message: string;
  variants?: string[];
}

//CORS helpers
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}


// @ts-ignore
Deno.serve(async (req: Request) => {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ── 1. Authenticate the user
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  // @ts-ignore
  const supabaseUrl: string = Deno.env.get("SUPABASE_URL")!;
  // @ts-ignore
  const supabaseAnonKey: string = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const userId: string = user.id;

  // @ts-ignore
  const databaseUrl: string | undefined = Deno.env.get("APP_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL");
  if (!databaseUrl) {
    return jsonResponse({ error: "Server misconfiguration" }, 500);
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    //Execute the checkout inside a transaction
    const result = await sql.begin(async (tx: ReturnType<typeof postgres>) => {
      //Fetch cart items joined with variant + product prices
      const cartRows: CartRow[] = await tx`
        SELECT
          ci.id          AS cart_item_id,
          ci.variant_id,
          ci.quantity     AS requested_qty,
          pv.stock_quantity,
          p.base_price
        FROM cart_items ci
        JOIN product_variants pv ON pv.id = ci.variant_id
        JOIN products          p ON p.id  = pv.product_id
        WHERE ci.user_id = ${userId}
        ORDER BY pv.id          -- consistent lock order to prevent deadlocks
        FOR UPDATE OF pv, ci    -- lock both variants AND cart rows to prevent double-checkout
      `;

      if (cartRows.length === 0) {
        throw { userError: true, status: 400, message: "Cart is empty" } as UserError;
      }

      //Verify stock for every item
      const outOfStock: string[] = [];
      for (const row of cartRows) {
        if (row.requested_qty > row.stock_quantity) {
          outOfStock.push(row.variant_id);
        }
      }
      if (outOfStock.length > 0) {
        throw {
          userError: true,
          status: 400,
          message: "Insufficient stock for variant(s)",
          variants: outOfStock,
        } as UserError;
      }

      let total = 0;
      for (const row of cartRows) {
        total += Number(row.base_price) * row.requested_qty;
      }
      total = Math.round(total * 100) / 100;

      const [order] = await tx`
        INSERT INTO orders (user_id, status, total)
        VALUES (${userId}, 'pending', ${total})
        RETURNING id
      `;
      const orderId: string = order.id;

      const orderItemsData = cartRows.map((row: CartRow) => ({
        order_id: orderId,
        variant_id: row.variant_id,
        unit_price: Number(row.base_price),
        quantity: row.requested_qty,
        line_total: Math.round(Number(row.base_price) * row.requested_qty * 100) / 100,
      }));

      await tx`
        INSERT INTO order_items ${tx(orderItemsData, "order_id", "variant_id", "unit_price", "quantity", "line_total")}
      `;

      //Decrement stock for each variant
      for (const row of cartRows) {
        await tx`
          UPDATE product_variants
          SET stock_quantity = stock_quantity - ${row.requested_qty}
          WHERE id = ${row.variant_id}
        `;
      }

      //Clear cart items
      const cartItemIds = cartRows.map((r: CartRow) => r.cart_item_id);
      await tx`
        DELETE FROM cart_items WHERE id IN ${tx(cartItemIds)}
      `;

      return { orderId, total };
    });

    return jsonResponse({
      message: "Order placed successfully",
      order_id: result.orderId,
      total: result.total,
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "userError" in err
    ) {
      const e = err as UserError;
      return jsonResponse(
        { error: e.message, ...(e.variants && { variants: e.variants }) },
        e.status,
      );
    }

    console.error("Checkout error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  } finally {
    await sql.end();
  }
});
