-- ============================================================
-- SUPABASE RPC HELPER FUNCTIONS
-- These run with SECURITY DEFINER (server-level permissions)
-- ============================================================

-- Increment inventory safely (upsert)
CREATE OR REPLACE FUNCTION public.increment_inventory(
  p_user_id UUID,
  p_plant_key TEXT,
  p_amount INT DEFAULT 1
) RETURNS VOID AS $$
BEGIN
  INSERT INTO public.inventory (user_id, plant_key, quantity)
  VALUES (p_user_id, p_plant_key, p_amount)
  ON CONFLICT (user_id, plant_key)
  DO UPDATE SET quantity = inventory.quantity + p_amount;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Decrement inventory with validation
CREATE OR REPLACE FUNCTION public.decrement_inventory(
  p_user_id UUID,
  p_plant_key TEXT,
  p_amount INT DEFAULT 1
) RETURNS VOID AS $$
DECLARE
  current_qty INT;
BEGIN
  SELECT quantity INTO current_qty
  FROM public.inventory
  WHERE user_id = p_user_id AND plant_key = p_plant_key;

  IF current_qty IS NULL OR current_qty < p_amount THEN
    RAISE EXCEPTION 'Insufficient inventory: % (have %)', p_plant_key, COALESCE(current_qty, 0);
  END IF;

  UPDATE public.inventory
  SET quantity = quantity - p_amount
  WHERE user_id = p_user_id AND plant_key = p_plant_key;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment coins safely
CREATE OR REPLACE FUNCTION public.increment_coins(
  p_user_id UUID,
  p_amount BIGINT
) RETURNS BIGINT AS $$
DECLARE
  new_balance BIGINT;
BEGIN
  UPDATE public.users
  SET coins = coins + p_amount
  WHERE id = p_user_id
  RETURNING coins INTO new_balance;
  RETURN new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment quest progress and auto-complete
CREATE OR REPLACE FUNCTION public.increment_quest_progress(
  p_user_id UUID,
  p_stat_key TEXT,
  p_amount INT DEFAULT 1
) RETURNS VOID AS $$
DECLARE
  quest_rec RECORD;
BEGIN
  FOR quest_rec IN
    SELECT q.key, q.target, q.reward_coins, q.reward_xp,
           COALESCE(qp.progress, 0) as current_progress,
           COALESCE(qp.completed, FALSE) as is_completed
    FROM public.quests q
    LEFT JOIN public.quest_progress qp
      ON qp.quest_key = q.key AND qp.user_id = p_user_id
    WHERE q.stat_key = p_stat_key
  LOOP
    IF NOT quest_rec.is_completed THEN
      -- Upsert progress
      INSERT INTO public.quest_progress (user_id, quest_key, progress)
      VALUES (p_user_id, quest_rec.key, p_amount)
      ON CONFLICT (user_id, quest_key)
      DO UPDATE SET progress = quest_progress.progress + p_amount;

      -- Auto-complete if target reached
      IF quest_rec.current_progress + p_amount >= quest_rec.target THEN
        UPDATE public.quest_progress
        SET completed = TRUE, completed_at = NOW()
        WHERE user_id = p_user_id AND quest_key = quest_rec.key;
      END IF;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Claim quest reward
CREATE OR REPLACE FUNCTION public.claim_quest_reward(
  p_user_id UUID,
  p_quest_key TEXT
) RETURNS JSONB AS $$
DECLARE
  quest_rec RECORD;
  user_rec RECORD;
  result JSONB;
BEGIN
  -- Get quest and progress
  SELECT q.*, qp.completed, qp.claimed
  INTO quest_rec
  FROM public.quests q
  JOIN public.quest_progress qp ON qp.quest_key = q.key
  WHERE q.key = p_quest_key AND qp.user_id = p_user_id;

  IF quest_rec IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Quest not found');
  END IF;
  IF NOT quest_rec.completed THEN
    RETURN jsonb_build_object('success', false, 'error', 'Quest not completed');
  END IF;
  IF quest_rec.claimed THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already claimed');
  END IF;

  -- Give rewards
  SELECT coins, xp, level INTO user_rec FROM public.users WHERE id = p_user_id;

  UPDATE public.users
  SET coins = coins + quest_rec.reward_coins,
      xp = xp + quest_rec.reward_xp
  WHERE id = p_user_id;

  UPDATE public.quest_progress
  SET claimed = TRUE WHERE user_id = p_user_id AND quest_key = p_quest_key;

  INSERT INTO public.coin_logs (user_id, amount, balance_after, source, metadata)
  VALUES (p_user_id, quest_rec.reward_coins, user_rec.coins + quest_rec.reward_coins,
          'quest', jsonb_build_object('quest_key', p_quest_key));

  RETURN jsonb_build_object(
    'success', true,
    'reward_coins', quest_rec.reward_coins,
    'reward_xp', quest_rec.reward_xp,
    'new_coins', user_rec.coins + quest_rec.reward_coins
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Gacha: open a plant box (server-side random)
CREATE OR REPLACE FUNCTION public.open_gacha_box(
  p_user_id UUID,
  p_box_type TEXT DEFAULT 'plant'
) RETURNS JSONB AS $$
DECLARE
  user_coins BIGINT;
  box_cost INT := 1000;
  result_plant TEXT;
  rand_val FLOAT;
BEGIN
  SELECT coins INTO user_coins FROM public.users WHERE id = p_user_id;
  IF user_coins < box_cost THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient coins');
  END IF;

  -- Server-side weighted random
  rand_val := random();
  IF rand_val < 0.60 THEN
    result_plant := (ARRAY['flower','leaf','sun','potato'])[floor(random()*4)::int + 1];
  ELSIF rand_val < 0.85 THEN
    result_plant := (ARRAY['statue','crystalFlower','moonLeaf'])[floor(random()*3)::int + 1];
  ELSIF rand_val < 0.96 THEN
    result_plant := (ARRAY['goldenSun','dragonFruit'])[floor(random()*2)::int + 1];
  ELSE
    result_plant := 'phoenixBloom';
  END IF;

  -- Deduct coins
  UPDATE public.users SET coins = coins - box_cost WHERE id = p_user_id;

  -- Add to inventory
  PERFORM public.increment_inventory(p_user_id, result_plant, 1);

  INSERT INTO public.coin_logs (user_id, amount, balance_after, source, metadata)
  VALUES (p_user_id, -box_cost, user_coins - box_cost, 'gacha',
          jsonb_build_object('result', result_plant));

  -- Get plant details
  RETURN jsonb_build_object(
    'success', true,
    'plant_key', result_plant,
    'new_coins', user_coins - box_cost
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
