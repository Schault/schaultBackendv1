/// <reference lib="deno.ns" />

import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

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
    "authorization, x-client-info, apikey, content-type, idempotency-key",
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

// ── Database connection (shared across invocations) ─────────────────
// Moved outside the handler so connections are reused in long-lived
// Deno workers instead of creating a new TCP connection per request.
const databaseUrl: string | undefined = Deno.env.get("APP_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL");
// Connection timeouts to prevent hanging on deadlocks or network issues.
const sql = databaseUrl
  ? postgres(databaseUrl, {
      max: 1,
      idle_timeout: 10,
      connect_timeout: 5,
      max_lifetime: 60,
    })
  : null;

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

  let requestBody = {};
  try {
    if (req.body) {
      requestBody = await req.json();
    }
  } catch (e) {
    // Ignore invalid JSON
  }
  const shippingAddress = (requestBody as any).shipping_address || null;

  // ── Shipping address validation ───────────
  interface ShippingAddress {
    full_name: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postal_code: string;
    phone?: string;
  }

  function validateShippingAddress(addr: unknown): addr is ShippingAddress {
    if (!addr || typeof addr !== 'object') return false;
    const a = addr as Record<string, unknown>;
    if (typeof a.full_name !== 'string' || a.full_name.length < 1 || a.full_name.length > 200) return false;
    if (typeof a.line1 !== 'string' || a.line1.length < 1 || a.line1.length > 500) return false;
    if (a.line2 !== undefined && (typeof a.line2 !== 'string' || a.line2.length > 500)) return false;
    if (typeof a.city !== 'string' || a.city.length < 1 || a.city.length > 100) return false;
    if (typeof a.state !== 'string' || a.state.length < 1 || a.state.length > 100) return false;
    if (typeof a.postal_code !== 'string' || !/^\d{5,6}$/.test(a.postal_code)) return false;
    if (a.phone !== undefined && (typeof a.phone !== 'string' || a.phone.length > 20)) return false;
    return true;
  }

  // Shipping address is required — reject checkout without one.
  if (!validateShippingAddress(shippingAddress)) {
    return jsonResponse({ error: "Missing or invalid shipping address" }, 400);
  }

  //  0. Validate Idempotency-Key header (strictly required) 
  const idempotencyKey = req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.trim().length === 0) {
    return jsonResponse(
      { error: "Missing required Idempotency-Key header" },
      400,
    );
  }
  // Basic length sanity check – a UUID is 36 chars; allow up to 128 for flexibility
  if (idempotencyKey.length > 128) {
    return jsonResponse(
      { error: "Idempotency-Key header too long (max 128 characters)" },
      400,
    );
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

  //  2. Verify database connection is available 
  if (!sql) {
    console.error("FATAL: No database URL configured");
    return jsonResponse({ error: "Server misconfiguration" }, 500);
  }

  //  2a. Rate limiting — enforce per-user checkout throttle 
  try {
    const [rateCheck] = await sql`
      SELECT check_checkout_rate_limit(${userId}) AS result
    `;
    const rateResult = rateCheck.result;
    if (!rateResult.allowed) {
      console.log(
        JSON.stringify({
          event: "checkout_rate_limited",
          userId,
          retryAfterSeconds: rateResult.retry_after_seconds,
          ts: new Date().toISOString(),
        }),
      );
      return new Response(
        JSON.stringify({
          error: "Too many checkout attempts. Please try again later.",
          retry_after_seconds: rateResult.retry_after_seconds,
        }),
        {
          status: 429,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json",
            "Retry-After": String(rateResult.retry_after_seconds),
          },
        },
      );
    }
  } catch (rateLimitErr) {
    // Fail CLOSED. Attackers must not be able to bypass rate limiting
    // by triggering deliberate database errors.
    console.error(
      JSON.stringify({
        event: "rate_limit_check_error",
        userId,
        error: rateLimitErr instanceof Error ? rateLimitErr.message : String(rateLimitErr),
        ts: new Date().toISOString(),
      }),
    );
    return jsonResponse({ error: "Internal server error during checkout verification" }, 500);
  }

  try {
    //  3. Execute checkout in a single transaction 
    const result = await sql.begin(
      async (tx: ReturnType<typeof postgres>) => {
        // ── Idempotency: upsert + row-level lock ──────────────────────────
        const [keyRec] = await tx`
          INSERT INTO idempotency_keys (user_id, key_name)
          VALUES (${userId}, ${idempotencyKey})
          ON CONFLICT (user_id, key_name)
          DO UPDATE SET locked_at = now()
          RETURNING response_body, response_status_code
        `;

        if (keyRec.response_body !== null) {
          return {
            __idempotent_replay: true,
            body: keyRec.response_body,
            statusCode: keyRec.response_status_code,
          };
        }

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
          INSERT INTO orders (user_id, status, total, estimated_delivery, shipping_address)
          VALUES (${userId}, 'confirmed', ${total}, now() + interval '7 days', ${shippingAddress ? JSON.stringify(shippingAddress) : null}::jsonb)
          RETURNING id, estimated_delivery
        `;
        const orderId: string = order.id;
        const estimatedDelivery: string = order.estimated_delivery;

        await tx`
          INSERT INTO order_status_history (order_id, status, note)
          VALUES (${orderId}, 'confirmed', 'Order placed and payment confirmed')
        `;

        // 3e. Insert order items (single bulk insert)
        const orderItemsData = cartRows.map((row: CartRow) => ({
          order_id: orderId,
          variant_id: row.variant_id,
          unit_price: Number(row.base_price),
          quantity: row.requested_qty,
          line_total: Math.round(Number(row.base_price) * row.requested_qty * 100) / 100,
        }));

        await tx`
          INSERT INTO order_items ${tx(
            orderItemsData,
            "order_id",
            "variant_id",
            "unit_price",
            "quantity",
            "line_total"
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

        // ── Idempotency: persist the successful response ────────────────
        const successBody = {
          message: "Order placed successfully",
          order_id: orderId,
          total,
          estimated_delivery: estimatedDelivery,
        };
        await tx`
          UPDATE idempotency_keys
          SET response_body = ${JSON.stringify(successBody)}::jsonb,
              response_status_code = 200,
              completed_at = now()
          WHERE user_id = ${userId}
            AND key_name = ${idempotencyKey}
        `;

        return { orderId, total, estimatedDelivery, itemCount: cartRows.length };
      },
    );

    // ── Handle idempotent replay (already-completed checkout) ─────────
    if (result.__idempotent_replay) {
      console.log(
        JSON.stringify({
          event: "checkout_idempotent_replay",
          userId,
          idempotencyKey,
          ts: new Date().toISOString(),
        }),
      );
      return jsonResponse(result.body as Record<string, unknown>, result.statusCode as number);
    }

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
      estimated_delivery: result.estimatedDelivery,
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
  }
});
