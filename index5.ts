// supabase/functions/claim-farm-reward/index.ts
// Server-side harvest validation — clients CANNOT manipulate rewards

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RARITY_MULTIPLIER: Record<string, number> = {
  common: 1, rare: 2, epic: 5, legendary: 10, limited: 8,
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return error("Unauthorized", 401);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !user) return error("Unauthorized", 401);

    const { slot_index } = await req.json();
    if (slot_index === undefined || slot_index < 0 || slot_index > 19) {
      return error("Invalid slot_index");
    }

    // Get the farm slot
    const { data: slot, error: slotErr } = await supabase
      .from("farm_slots")
      .select("*, plants(*)")
      .eq("user_id", user.id)
      .eq("slot_index", slot_index)
      .single();

    if (slotErr || !slot) return error("Slot not found");
    if (!slot.plant_key) return error("Slot is empty");
    if (!slot.ready_at) return error("Nothing planted");

    // SERVER validates readiness — not client
    const now = new Date();
    const readyAt = new Date(slot.ready_at);
    if (now < readyAt) {
      return error(`Not ready yet. Ready in ${Math.ceil((readyAt.getTime() - now.getTime()) / 1000)}s`);
    }

    // Get plant data
    const { data: plant } = await supabase
      .from("plants")
      .select("*")
      .eq("key", slot.plant_key)
      .single();

    if (!plant) return error("Plant data missing");

    // Calculate reward server-side
    const multiplier = RARITY_MULTIPLIER[plant.rarity] ?? 1;
    const elapsedSeconds = (now.getTime() - readyAt.getTime()) / 1000;
    // Bonus for waiting (up to 2x if waited 2x growth time)
    const overtimeBonus = Math.min(1 + elapsedSeconds / plant.growth_time, 2);
    const reward = Math.floor(plant.base_yield * multiplier * overtimeBonus);

    // Get current user coins
    const { data: userData } = await supabase
      .from("users")
      .select("coins, xp, level")
      .eq("id", user.id)
      .single();

    if (!userData) return error("User not found");

    const newCoins = userData.coins + reward;
    const xpGained = Math.floor(reward * 0.1);
    const newXp = userData.xp + xpGained;
    const newLevel = calcLevel(newXp);

    // Atomic: update all in one go
    const [updateUser, clearSlot, logCoin, updateProgress] = await Promise.all([
      supabase.from("users").update({
        coins: newCoins,
        xp: newXp,
        level: newLevel,
      }).eq("id", user.id),

      supabase.from("farm_slots").update({
        plant_key: null,
        planted_at: null,
        ready_at: null,
      }).eq("user_id", user.id).eq("slot_index", slot_index),

      supabase.from("coin_logs").insert({
        user_id: user.id,
        amount: reward,
        balance_after: newCoins,
        source: "farm",
        metadata: { plant_key: plant.key, rarity: plant.rarity, slot_index, multiplier, overtime_bonus: overtimeBonus },
      }),

      // Update quest progress
      supabase.rpc("increment_quest_progress", {
        p_user_id: user.id,
        p_stat_key: "harvests",
        p_amount: 1,
      }).catch(() => null), // Non-critical
    ]);

    if (updateUser.error) return error("Failed to update coins: " + updateUser.error.message);

    return json({
      success: true,
      reward,
      xp_gained: xpGained,
      new_coins: newCoins,
      new_xp: newXp,
      new_level: newLevel,
      plant: { key: plant.key, name: plant.name, rarity: plant.rarity },
    });

  } catch (e) {
    console.error("claim-farm-reward error:", e);
    return error("Internal server error", 500);
  }
});

function calcLevel(xp: number): number {
  // XP thresholds: 100, 300, 600, 1000, 1500... (quadratic)
  let level = 1;
  let threshold = 100;
  while (xp >= threshold && level < 100) {
    xp -= threshold;
    level++;
    threshold = Math.floor(threshold * 1.5);
  }
  return level;
}

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
