/// <reference lib="deno.ns" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: []
};

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

    if (!order_id || !new_status) {
      return jsonResponse({ error: "Missing order_id or new_status" }, 400);
    }

    // Must use service role key for admin operations
    const authHeader = req.headers.get("Authorization");
    // @ts-ignore
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!authHeader || authHeader.replace("Bearer ", "") !== serviceRoleKey) {
        return jsonResponse({ error: "Unauthorized. Admin only." }, 401);
    }

    // @ts-ignore
    const supabaseUrl: string = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Get current status
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('status')
      .eq('id', order_id)
      .single();

    if (fetchError || !order) {
      return jsonResponse({ error: "Order not found" }, 404);
    }

    const currentStatus = order.status;

    // Validate transition
    if (!ALLOWED_TRANSITIONS[currentStatus]?.includes(new_status)) {
      return jsonResponse({ 
        error: `Invalid transition from ${currentStatus} to ${new_status}` 
      }, 400);
    }

    // Update order status (the trigger will handle history insertion)
    const { error: updateError } = await supabase
      .from('orders')
      .update({ status: new_status })
      .eq('id', order_id);

    if (updateError) {
      throw updateError;
    }

    // Optional: add note to history
    if (note) {
        // Wait for the trigger to have fired, then update the most recent history row
        const { data: historyRow } = await supabase
            .from('order_status_history')
            .select('id')
            .eq('order_id', order_id)
            .eq('status', new_status)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
            
        if (historyRow) {
            await supabase
                .from('order_status_history')
                .update({ note })
                .eq('id', historyRow.id);
        }
    }

    return jsonResponse({ message: "Status updated successfully" });
  } catch (err) {
    console.error("Error updating order status:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
