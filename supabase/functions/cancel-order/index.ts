/// <reference lib="deno.ns" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS helpers — restricted origin
const ALLOWED_ORIGIN =
  Deno.env.get("ALLOWED_ORIGIN") ?? "http://localhost:3000";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Input validation
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Statuses that customers are allowed to cancel from.
// Once an order moves to 'processing' or beyond, only admins can cancel.
const CUSTOMER_CANCELLABLE_STATUSES = ["pending", "confirmed"];

// @ts-ignore
Deno.serve(async (req: Request) => {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const { order_id, reason } = await req.json();

    // ── Input validation ────────────────────────────────────────────────
    if (
      !order_id ||
      typeof order_id !== "string" ||
      !UUID_REGEX.test(order_id)
    ) {
      return jsonResponse({ error: "Invalid or missing order_id" }, 400);
    }

    if (
      reason !== undefined &&
      (typeof reason !== "string" || reason.length > 500)
    ) {
      return jsonResponse(
        { error: "Reason must be a string of at most 500 characters" },
        400
      );
    }

    // ── Authenticate the user ───────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      {
        global: { headers: { Authorization: authHeader } },
      }
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const userId: string = user.id;

    // ── Fetch the order (with service-role to bypass RLS) ───────────────
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: order, error: fetchError } = await adminClient
      .from("orders")
      .select("id, user_id, status")
      .eq("id", order_id)
      .single();

    if (fetchError || !order) {
      return jsonResponse({ error: "Order not found" }, 404);
    }

    // ── Authorization: must own the order ───────────────────────────────
    if (order.user_id !== userId) {
      return jsonResponse(
        { error: "You can only cancel your own orders" },
        403
      );
    }

    // ── Check cancellation window ───────────────────────────────────────
    if (!CUSTOMER_CANCELLABLE_STATUSES.includes(order.status)) {
      if (order.status === "cancelled") {
        return jsonResponse(
          { error: "This order has already been cancelled" },
          400
        );
      }
      return jsonResponse(
        { error: "This order can no longer be cancelled. Please contact support." },
        403
      );
    }

    // ── Transition status via atomic RPC ─────────────────────────────────
    const cancellationNote = reason
      ? `Cancelled by customer: ${reason}`
      : "Cancelled by customer";

    const { data: rpcResult, error: rpcError } = await adminClient.rpc(
      "transition_order_status",
      {
        p_order_id: order_id,
        p_new_status: "cancelled",
        p_note: cancellationNote,
      }
    );

    if (rpcError) {
      throw rpcError;
    }

    // The RPC returns { error: "..." } or { status: "ok", ... }
    if (rpcResult.error) {
      return jsonResponse({ error: rpcResult.error }, 400);
    }

    // Stock restoration happens automatically via the
    // restore_stock_on_cancellation() trigger.

    console.log(
      JSON.stringify({
        event: "order_cancelled_by_customer",
        userId,
        orderId: order_id,
        previousStatus: rpcResult.previous_status,
        ts: new Date().toISOString(),
      })
    );

    return jsonResponse({ message: "Order cancelled successfully" });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "cancel_order_error",
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        ts: new Date().toISOString(),
      })
    );
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
