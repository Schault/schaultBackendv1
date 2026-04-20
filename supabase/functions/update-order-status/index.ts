/// <reference lib="deno.ns" />

import { createClient } from "npm:@supabase/supabase-js@2";

// CORS helpers — restricted origin (CRIT-1 fix)
const ALLOWED_ORIGIN =
  Deno.env.get("ALLOWED_ORIGIN") ?? "http://localhost:3000";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Input validation constants (CRIT-5 fix)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];

// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const { order_id, new_status, note } = await req.json();

    // Strict input validation (CRIT-5 fix)
    if (!order_id || typeof order_id !== 'string' || !UUID_REGEX.test(order_id)) {
      return jsonResponse({ error: "Invalid or missing order_id" }, 400);
    }
    if (!new_status || typeof new_status !== 'string' || !VALID_STATUSES.includes(new_status)) {
      return jsonResponse({ error: "Invalid or missing new_status" }, 400);
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
      return jsonResponse({ error: "Note must be a string of at most 500 characters" }, 400);
    }

    // Must use service role key for admin operations
    const authHeader = req.headers.get("Authorization");
    // @ts-ignore
    if (!authHeader){
      return jsonResponse({ error: "Missing auth header" }, 401);
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
      error,
    } = await supabase.auth.getUser();
    
    if (error || !user) {
      return jsonResponse({ error: "Invalid Token" }, 401);
    }

    const role = user.app_metadata?.role;
    if (role !== "admin") {
      return jsonResponse({ error: "Forbidden: Admins only" }, 403);
    }

    // INT-1 + INT-5 fix: Call the atomic database function instead of
    // doing separate read → validate → write → fetch → update operations.
    // The DB function uses SELECT ... FOR UPDATE to prevent race conditions
    // and handles the note update atomically within the same transaction.
    const { data, error: rpcError } = await supabase.rpc('transition_order_status', {
      p_order_id: order_id,
      p_new_status: new_status,
      p_note: note ?? null,
    });

    if (rpcError) {
      throw rpcError;
    }

    // The function returns a JSON object with either { error: "..." } or { status: "ok", ... }
    if (data.error) {
      // Map known errors to appropriate HTTP status codes
      if (data.error === 'Order not found') {
        return jsonResponse({ error: data.error }, 404);
      }
      // Invalid transition
      return jsonResponse({ error: data.error }, 400);
    }

    return jsonResponse({ message: "Status updated successfully" });
  } catch (err) {
    console.error("Error updating order status:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
