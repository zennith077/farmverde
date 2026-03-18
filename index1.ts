// supabase/functions/plant-seed/index.ts
// Server validates: slot availability, inventory, level requirements

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

    const { slot_index, plant_key } = await req.json();
    if (slot_index === undefined || !plant_key) return error("Missing slot_index or plant_key");

    // Get user data
    const { data: userData } = await supabase
      .from("users").select("level, total_plots").eq("id", user.id).single();
    if (!userData) return error("User not found");

    // Validate slot is within unlocked plots
    if (slot_index >= userData.total_plots) return error("Slot not unlocked yet");

    // Get the farm slot
    const { data: slot } = await supabase
      .from("farm_slots").select("*")
      .eq("user_id", user.id).eq("slot_index", slot_index).single();
    if (!slot) return error("Slot not found");
    if (slot.plant_key) return error("Slot is already occupied");

    // Get plant definition
    const { data: plant } = await supabase
      .from("plants").select("*").eq("key", plant_key).single();
    if (!plant) return error("Unknown plant");
    if (plant.unlock_level > userData.level) {
      return error(`Plant requires Level ${plant.unlock_level}. You are Level ${userData.level}`);
    }

    // Check inventory
    const { data: invItem } = await supabase
      .from("inventory")
      .select("quantity").eq("user_id", user.id).eq("plant_key", plant_key).single();
    if (!invItem || invItem.quantity < 1) return error("Plant not in inventory");

    const now = new Date();
    const readyAt = new Date(now.getTime() + plant.growth_time * 1000);

    // Atomic: plant + deduct inventory
    const [plantResult, invResult] = await Promise.all([
      supabase.from("farm_slots").update({
        plant_key,
        planted_at: now.toISOString(),
        ready_at: readyAt.toISOString(),
      }).eq("user_id", user.id).eq("slot_index", slot_index),

      supabase.rpc("decrement_inventory", {
        p_user_id: user.id,
        p_plant_key: plant_key,
        p_amount: 1,
      }),
    ]);

    if (plantResult.error) return error("Failed to plant: " + plantResult.error.message);

    // Quest progress
    supabase.rpc("increment_quest_progress", {
      p_user_id: user.id, p_stat_key: "plants", p_amount: 1,
    }).catch(() => null);

    return json({
      success: true,
      slot_index,
      plant_key,
      planted_at: now.toISOString(),
      ready_at: readyAt.toISOString(),
      growth_time: plant.growth_time,
    });

  } catch (e) {
    console.error("plant-seed error:", e);
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
