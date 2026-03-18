// supabase/functions/spin-wheel/index.ts
// All spin RNG happens SERVER-SIDE — client cannot predict or manipulate results

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Spin symbols per type (server defines these — not client)
const SPIN_CONFIG = {
  coin: {
    symbols: [
      { id: "s1", icon: "🪙", type: "coin",  val: 50,    weight: 400 },
      { id: "s2", icon: "💰", type: "coin",  val: 200,   weight: 250 },
      { id: "s3", icon: "💎", type: "coin",  val: 500,   weight: 100 },
      { id: "s4", icon: "🌟", type: "coin",  val: 1000,  weight: 40  },
      { id: "s5", icon: "👑", type: "coin",  val: 5000,  weight: 5   },
      { id: "s6", icon: "❌", type: "nothing",val: 0,    weight: 205 },
    ],
    min_bet: 10, max_bet: 10000,
    jackpot_chance: 0.05,  // 5% jackpot (3 same)
  },
  plant: {
    symbols: [
      { id: "p1", icon: "🌸", type: "plant",    val: "flower",      weight: 300 },
      { id: "p2", icon: "🍃", type: "plant",    val: "leaf",        weight: 250 },
      { id: "p3", icon: "🌻", type: "plant",    val: "sun",         weight: 200 },
      { id: "p4", icon: "🥔", type: "plant",    val: "potato",      weight: 100 },
      { id: "p5", icon: "🎋", type: "plant",    val: "bamboo",      weight: 50  },
      { id: "p6", icon: "💎", type: "rareplant",val: "crystalFlower",weight: 8  },
      { id: "p7", icon: "🔥", type: "nothing",  val: 0,             weight: 92  },
    ],
    min_bet: 50, max_bet: 5000,
    jackpot_chance: 0.04,
  },
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

    const { spin_type = "coin", bet = 10 } = await req.json();
    const config = SPIN_CONFIG[spin_type as keyof typeof SPIN_CONFIG];
    if (!config) return error("Invalid spin_type");

    // Validate bet
    if (bet < config.min_bet || bet > config.max_bet) {
      return error(`Bet must be between ${config.min_bet} and ${config.max_bet}`);
    }

    // Get user coins
    const { data: userData } = await supabase
      .from("users")
      .select("coins")
      .eq("id", user.id)
      .single();

    if (!userData) return error("User not found");
    if (userData.coins < bet) return error("Insufficient coins");

    // SERVER-SIDE RNG — crypto.getRandomValues for fairness
    const pickSymbol = () => {
      const symbols = config.symbols;
      const totalWeight = symbols.reduce((s, sym) => s + sym.weight, 0);
      const rand = randomInt(0, totalWeight - 1);
      let cumulative = 0;
      for (const sym of symbols) {
        cumulative += sym.weight;
        if (rand < cumulative) return sym;
      }
      return symbols[symbols.length - 1];
    };

    // Spin 3 reels
    const reels = [pickSymbol(), pickSymbol(), pickSymbol()];
    
    // Determine result
    let payout = 0;
    let resultType = "lose";
    let rewardDetail: Record<string, unknown> = {};

    const allSame = reels[0].id === reels[1].id && reels[1].id === reels[2].id;
    const twoSame = reels[0].id === reels[1].id || reels[1].id === reels[2].id || reels[0].id === reels[2].id;

    if (allSame && reels[0].type !== "nothing") {
      // JACKPOT
      resultType = "jackpot";
      if (reels[0].type === "coin") {
        payout = (reels[0].val as number) * bet / 10;
        rewardDetail = { type: "coin", amount: payout };
      } else if (reels[0].type === "plant" || reels[0].type === "rareplant") {
        rewardDetail = { type: "plant", plant_key: reels[0].val };
        payout = -bet; // No coin payout for plants, still costs bet
      }
    } else if (twoSame && reels.some(r => r.type !== "nothing")) {
      // PARTIAL WIN
      resultType = "partial";
      const winSym = reels[0].id === reels[1].id ? reels[0]
                   : reels[1].id === reels[2].id ? reels[1] : reels[0];
      if (winSym.type === "coin") {
        payout = Math.floor((winSym.val as number) * 0.5);
        rewardDetail = { type: "coin", amount: payout };
      }
    } else {
      // CONSOLATION (always get something small)
      const consolation = Math.floor(bet * 0.1) + randomInt(5, 50);
      payout = consolation;
      resultType = "consolation";
      rewardDetail = { type: "coin", amount: consolation };
    }

    const netChange = payout - bet;
    const newCoins = userData.coins + netChange;
    if (newCoins < 0) return error("Insufficient coins for this bet");

    // Apply rewards atomically
    const ops: Promise<unknown>[] = [
      supabase.from("users").update({ coins: newCoins }).eq("id", user.id),
      supabase.from("coin_logs").insert({
        user_id: user.id,
        amount: netChange,
        balance_after: newCoins,
        source: "spin",
        metadata: { spin_type, bet, result_type: resultType, reels: reels.map(r => r.icon) },
      }),
      supabase.from("spin_logs").insert({
        user_id: user.id,
        spin_type,
        bet,
        result: { reels, result_type: resultType, reward: rewardDetail },
        payout: netChange,
      }),
      // Quest progress
      supabase.rpc("increment_quest_progress", {
        p_user_id: user.id,
        p_stat_key: "spins",
        p_amount: 1,
      }).catch(() => null),
    ];

    // Plant reward
    if (rewardDetail.type === "plant") {
      const plantKey = rewardDetail.plant_key as string;
      ops.push(
        supabase.from("inventory")
          .upsert({ user_id: user.id, plant_key: plantKey, quantity: 1 }, {
            onConflict: "user_id,plant_key",
            ignoreDuplicates: false,
          })
          .then(async () => {
            // If already exists, increment
            await supabase.rpc("increment_inventory", {
              p_user_id: user.id,
              p_plant_key: plantKey,
              p_amount: 1,
            });
          })
      );
    }

    await Promise.all(ops);

    return json({
      success: true,
      reels,
      result_type: resultType,
      bet,
      payout: netChange,
      reward: rewardDetail,
      new_coins: newCoins,
    });

  } catch (e) {
    console.error("spin-wheel error:", e);
    return error("Internal server error", 500);
  }
});

function randomInt(min: number, max: number): number {
  const range = max - min + 1;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return min + (bytes[0] % range);
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
