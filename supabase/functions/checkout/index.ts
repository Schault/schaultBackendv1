/// <reference lib="deno.ns" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

//Types
interface CartRow {
  cart_item_id: string;
  variant_id: string;
  requested_qty: number;
  stock_quantity: number;
  base_price: string; // numeric comes back as string from pg
  product_name: string;
}

interface UserError {
  userError: true;
  status: number;
  message: string;
  variants?: string[];
}

// CORS helpers

const ALLOWED_ORIGIN =
  Deno.env.get("ALLOWED_ORIGIN") ?? "http://localhost:3000";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
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

//Handler 

// @ts-ignore
Deno.serve(async (req: Request) => {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Guardrail for oversized payloads 
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > 1024) {
    return jsonResponse({ error: "Payload too large" }, 413);
  }

  //  1. Authenticate the user 
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

  //  2. Acquire database connection 
  const databaseUrl: string | undefined = Deno.env.get("APP_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL");

  if (!databaseUrl) {
    console.error("FATAL: No database URL configured");
    return jsonResponse({ error: "Server misconfiguration" }, 500);
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    //  3. Execute checkout in a single transaction 
    const result = await sql.begin(
      async (tx: ReturnType<typeof postgres>) => {
        // 3a. Fetch & lock cart + variants + active products 
        const cartRows: CartRow[] = await tx`
          SELECT
            ci.id            AS cart_item_id,
            ci.variant_id,
            ci.quantity       AS requested_qty,
            pv.stock_quantity,
            p.base_price,
            p.name           AS product_name
          FROM cart_items ci
          JOIN product_variants pv ON pv.id = ci.variant_id
          JOIN products          p ON p.id  = pv.product_id
          WHERE ci.user_id = ${userId}
            AND p.is_active = true
          ORDER BY pv.id
          FOR UPDATE OF pv, ci
        `;

        if (cartRows.length === 0) {
          throw {
            userError: true,
            status: 400,
            message: "Cart is empty or all items are unavailable",
          } as UserError;
        }

        // 3b. Validate stock 
        const outOfStock: string[] = [];
        for (const row of cartRows) {
          if (row.requested_qty > row.stock_quantity) {
            outOfStock.push(row.variant_id);
          }
        }
        if (outOfStock.length > 0) {
          throw {
            userError: true,
            status: 409,
            message: "Insufficient stock for variant(s)",
            variants: outOfStock,
          } as UserError;
        }

        // 3c. Compute total in SQL (exact numeric arithmetic) 
        // We already have the rows locked, so recompute from the same snapshot
        const [{ total: computedTotal }] = await tx`
          SELECT COALESCE(SUM(p.base_price * ci.quantity), 0)::numeric(10,2) AS total
          FROM cart_items ci
          JOIN product_variants pv ON pv.id = ci.variant_id
          JOIN products          p ON p.id  = pv.product_id
          WHERE ci.user_id = ${userId}
            AND p.is_active = true
        `;
        const total = Number(computedTotal);

        // 3d. Create order 
        const [order] = await tx`
          INSERT INTO orders (user_id, status, total)
          VALUES (${userId}, 'pending', ${total})
          RETURNING id
        `;
        const orderId: string = order.id;

        // 3e. Insert order items (single bulk insert, computed in SQL)
        const orderItemsData = cartRows.map((row: CartRow) => ({
          order_id: orderId,
          variant_id: row.variant_id,
          unit_price: Number(row.base_price),
          quantity: row.requested_qty,
          line_total:
            Math.round(Number(row.base_price) * row.requested_qty * 100) / 100,
        }));

        await tx`
          INSERT INTO order_items ${tx(
            orderItemsData,
            "order_id",
            "variant_id",
            "unit_price",
            "quantity",
            "line_total",
          )}
        `;

        // 3f. Decrement stock (batched, with safety guard)
        const variantIds = cartRows.map((r: CartRow) => r.variant_id);
        const quantities = cartRows.map((r: CartRow) => r.requested_qty);

        const updated = await tx`
          UPDATE product_variants AS pv
          SET stock_quantity = pv.stock_quantity - batch.qty
          FROM (
            SELECT unnest(${variantIds}::uuid[]) AS vid,
                   unnest(${quantities}::int[])  AS qty
          ) AS batch
          WHERE pv.id = batch.vid
            AND pv.stock_quantity >= batch.qty
          RETURNING pv.id
        `;

        if (updated.length !== cartRows.length) {
          // This should never happen because we validated above with locks held,
          // but defense-in-depth demands we check.
          throw {
            userError: true,
            status: 409,
            message: "Stock changed during checkout — please retry",
          } as UserError;
        }

        // 3g. Clear processed cart items 
        const cartItemIds = cartRows.map((r: CartRow) => r.cart_item_id);
        await tx`
          DELETE FROM cart_items WHERE id IN ${tx(cartItemIds)}
        `;

        return { orderId, total, itemCount: cartRows.length };
      },
    );

    //4. Success logging 
    console.log(
      JSON.stringify({
        event: "checkout_success",
        userId,
        orderId: result.orderId,
        total: result.total,
        items: result.itemCount,
        ts: new Date().toISOString(),
      }),
    );

    return jsonResponse({
      message: "Order placed successfully",
      order_id: result.orderId,
      total: result.total,
    });
  } catch (err) {
    //User-facing errors (stock, empty cart, etc.) 
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

    //Unexpected errors — log detail, return generic message
    console.error(
      JSON.stringify({
        event: "checkout_error",
        userId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        ts: new Date().toISOString(),
      }),
    );
    return jsonResponse({ error: "Internal server error" }, 500);
  } finally {
    await sql.end();
  }
});
