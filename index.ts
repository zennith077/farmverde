// supabase/functions/marketplace-buy/index.ts
// Server validates price, transfers coins, updates inventory

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return error("Unauthorized", 401);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !user) return error("Unauthorized", 401);

    const { listing_id } = await req.json();
    if (!listing_id) return error("Missing listing_id");

    // Get listing
    const { data: listing } = await supabase
      .from("marketplace")
      .select("*, seller:seller_id(coins)")
      .eq("id", listing_id)
      .eq("status", "active")
      .single();

    if (!listing) return error("Listing not found or already sold");
    if (listing.seller_id === user.id) return error("Cannot buy your own listing");

    // Get buyer coins
    const { data: buyer } = await supabase
      .from("users").select("coins").eq("id", user.id).single();
    if (!buyer) return error("Buyer not found");
    if (buyer.coins < listing.price) return error("Insufficient coins");

    const PLATFORM_FEE = 0.05; // 5% fee
    const sellerGets = Math.floor(listing.price * (1 - PLATFORM_FEE));

    // Atomic transaction
    await Promise.all([
      // Deduct buyer
      supabase.from("users").update({ coins: buyer.coins - listing.price }).eq("id", user.id),
      // Pay seller
      supabase.rpc("increment_coins", { p_user_id: listing.seller_id, p_amount: sellerGets }),
      // Give item to buyer
      supabase.rpc("increment_inventory", {
        p_user_id: user.id, p_plant_key: listing.plant_key, p_amount: listing.quantity,
      }),
      // Mark listing sold
      supabase.from("marketplace").update({
        status: "sold", sold_at: new Date().toISOString(),
      }).eq("id", listing_id),
      // Coin logs
      supabase.from("coin_logs").insert([
        { user_id: user.id, amount: -listing.price, balance_after: buyer.coins - listing.price, source: "marketplace", metadata: { action: "buy", listing_id } },
        { user_id: listing.seller_id, amount: sellerGets, balance_after: 0, source: "marketplace", metadata: { action: "sell", listing_id, fee: listing.price - sellerGets } },
      ]),
    ]);

    return json({
      success: true,
      plant_key: listing.plant_key,
      quantity: listing.quantity,
      price_paid: listing.price,
      new_coins: buyer.coins - listing.price,
    });

  } catch (e) {
    console.error("marketplace-buy error:", e);
    return error("Internal server error", 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function error(msg: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error: msg }), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
