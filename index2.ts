// supabase/functions/daily-reward/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DAILY_REWARDS = [
  { day: 1, type: "coin",  val: 100,   label: "100 Koin" },
  { day: 2, type: "coin",  val: 200,   label: "200 Koin" },
  { day: 3, type: "plant", val: "flower", label: "Bunga x1" },
  { day: 4, type: "coin",  val: 400,   label: "400 Koin" },
  { day: 5, type: "coin",  val: 600,   label: "600 Koin" },
  { day: 6, type: "plant", val: "sun",  label: "Matahari x1" },
  { day: 7, type: "coin",  val: 1500,  label: "1.500 Koin (Bonus Minggu)" },
];

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

    const { data: userData } = await supabase
      .from("users")
      .select("coins, daily_streak, last_daily_claim")
      .eq("id", user.id)
      .single();

    if (!userData) return error("User not found");

    // Check 24-hour cooldown SERVER-SIDE
    const now = new Date();
    if (userData.last_daily_claim) {
      const lastClaim = new Date(userData.last_daily_claim);
      const hoursSince = (now.getTime() - lastClaim.getTime()) / 3600000;
      if (hoursSince < 24) {
        const hoursLeft = Math.ceil(24 - hoursSince);
        return error(`Already claimed. Try again in ${hoursLeft}h`);
      }
      // Check if streak should reset (>48h gap)
      if (hoursSince > 48) {
        // Reset streak
        await supabase.from("users").update({ daily_streak: 0 }).eq("id", user.id);
        userData.daily_streak = 0;
      }
    }

    const streakDay = (userData.daily_streak % 7);
    const reward = DAILY_REWARDS[streakDay];
    const newStreak = userData.daily_streak + 1;
    let newCoins = userData.coins;
    const ops: Promise<unknown>[] = [];

    if (reward.type === "coin") {
      newCoins += reward.val as number;
      ops.push(
        supabase.from("coin_logs").insert({
          user_id: user.id,
          amount: reward.val,
          balance_after: newCoins,
          source: "daily",
          metadata: { day: streakDay + 1, streak: newStreak },
        })
      );
    } else if (reward.type === "plant") {
      ops.push(
        supabase.rpc("increment_inventory", {
          p_user_id: user.id,
          p_plant_key: reward.val,
          p_amount: 1,
        })
      );
    }

    ops.push(
      supabase.from("users").update({
        coins: newCoins,
        daily_streak: newStreak,
        last_daily_claim: now.toISOString(),
      }).eq("id", user.id)
    );

    await Promise.all(ops);

    return json({
      success: true,
      reward,
      streak: newStreak,
      next_reward: DAILY_REWARDS[newStreak % 7],
      new_coins: newCoins,
    });

  } catch (e) {
    console.error("daily-reward error:", e);
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
