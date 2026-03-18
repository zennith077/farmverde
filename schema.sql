-- ============================================================
-- FARMVERDE SUPABASE SCHEMA
-- Production-ready with RLS, indexes, and full security
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE: users (extends Supabase auth.users)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.users (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username   TEXT UNIQUE NOT NULL,
  coins      BIGINT DEFAULT 200 CHECK (coins >= 0),
  xp         BIGINT DEFAULT 0 CHECK (xp >= 0),
  level      INT DEFAULT 1 CHECK (level >= 1),
  total_plots INT DEFAULT 10 CHECK (total_plots BETWEEN 10 AND 20),
  last_daily_claim TIMESTAMPTZ,
  daily_streak INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE: plants (master data, read-only for users)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.plants (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key          TEXT UNIQUE NOT NULL,  -- 'flower', 'leaf', etc
  name         TEXT NOT NULL,
  icon         TEXT NOT NULL,
  rarity       TEXT NOT NULL CHECK (rarity IN ('common','rare','epic','legendary','limited')),
  base_yield   INT NOT NULL,          -- coins per harvest
  growth_time  INT NOT NULL,          -- seconds to grow
  price        INT NOT NULL,          -- cost to buy seed
  unlock_level INT DEFAULT 1,
  is_limited   BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE: farm_slots
-- ============================================================
CREATE TABLE IF NOT EXISTS public.farm_slots (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  slot_index  INT NOT NULL CHECK (slot_index >= 0 AND slot_index < 20),
  plant_key   TEXT REFERENCES public.plants(key) ON DELETE SET NULL,
  planted_at  TIMESTAMPTZ,
  ready_at    TIMESTAMPTZ,
  UNIQUE(user_id, slot_index)
);

-- ============================================================
-- TABLE: inventory
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inventory (
  id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plant_key TEXT NOT NULL REFERENCES public.plants(key),
  quantity INT DEFAULT 0 CHECK (quantity >= 0),
  UNIQUE(user_id, plant_key)
);

-- ============================================================
-- TABLE: coin_logs (immutable audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.coin_logs (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount     BIGINT NOT NULL,             -- positive = gain, negative = spend
  balance_after BIGINT NOT NULL,
  source     TEXT NOT NULL,               -- 'farm','spin','quest','daily','shop','deposit'
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE: quests
-- ============================================================
CREATE TABLE IF NOT EXISTS public.quests (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key         TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  target      INT NOT NULL,
  reward_coins INT DEFAULT 0,
  reward_xp   INT DEFAULT 0,
  stat_key    TEXT NOT NULL              -- 'harvests','spins','purchases'
);

-- ============================================================
-- TABLE: quest_progress
-- ============================================================
CREATE TABLE IF NOT EXISTS public.quest_progress (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  quest_key   TEXT NOT NULL REFERENCES public.quests(key),
  progress    INT DEFAULT 0,
  completed   BOOLEAN DEFAULT FALSE,
  claimed     BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, quest_key)
);

-- ============================================================
-- TABLE: spin_logs (server-side spin results)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.spin_logs (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  spin_type  TEXT NOT NULL,
  bet        INT NOT NULL,
  result     JSONB NOT NULL,
  payout     BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE: marketplace
-- ============================================================
CREATE TABLE IF NOT EXISTS public.marketplace (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  seller_id   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plant_key   TEXT NOT NULL REFERENCES public.plants(key),
  quantity    INT NOT NULL CHECK (quantity > 0),
  price       INT NOT NULL CHECK (price > 0),
  status      TEXT DEFAULT 'active' CHECK (status IN ('active','sold','cancelled')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  sold_at     TIMESTAMPTZ
);

-- ============================================================
-- TABLE: weapons (for raid system)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.weapons (
  id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  weapon_key TEXT NOT NULL,
  quantity INT DEFAULT 0 CHECK (quantity >= 0),
  UNIQUE(user_id, weapon_key)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_farm_slots_user ON public.farm_slots(user_id);
CREATE INDEX idx_farm_slots_ready ON public.farm_slots(ready_at) WHERE plant_key IS NOT NULL;
CREATE INDEX idx_inventory_user ON public.inventory(user_id);
CREATE INDEX idx_coin_logs_user ON public.coin_logs(user_id, created_at DESC);
CREATE INDEX idx_quest_progress_user ON public.quest_progress(user_id);
CREATE INDEX idx_marketplace_status ON public.marketplace(status, created_at DESC);
CREATE INDEX idx_spin_logs_user ON public.spin_logs(user_id, created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE public.users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_slots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coin_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quest_progress  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spin_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weapons         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quests          ENABLE ROW LEVEL SECURITY;

-- Users: own row only
CREATE POLICY "users_select_own"  ON public.users FOR SELECT USING (auth.uid() = id);
CREATE POLICY "users_update_own"  ON public.users FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (
    -- Prevent client-side coin manipulation
    coins = (SELECT coins FROM public.users WHERE id = auth.uid())
  );

-- Farm slots: own rows
CREATE POLICY "farm_select_own"  ON public.farm_slots FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "farm_insert_own"  ON public.farm_slots FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "farm_update_own"  ON public.farm_slots FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "farm_delete_own"  ON public.farm_slots FOR DELETE USING (auth.uid() = user_id);

-- Inventory: own rows
CREATE POLICY "inv_select_own"   ON public.inventory FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "inv_insert_own"   ON public.inventory FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "inv_update_own"   ON public.inventory FOR UPDATE USING (auth.uid() = user_id);

-- Coin logs: read-only for users
CREATE POLICY "logs_select_own"  ON public.coin_logs FOR SELECT USING (auth.uid() = user_id);

-- Quest progress
CREATE POLICY "qp_select_own"    ON public.quest_progress FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "qp_insert_own"    ON public.quest_progress FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "qp_update_own"    ON public.quest_progress FOR UPDATE USING (auth.uid() = user_id);

-- Spin logs
CREATE POLICY "spin_select_own"  ON public.spin_logs FOR SELECT USING (auth.uid() = user_id);

-- Marketplace: read all active, write own
CREATE POLICY "mkt_select_all"   ON public.marketplace FOR SELECT USING (TRUE);
CREATE POLICY "mkt_insert_own"   ON public.marketplace FOR INSERT WITH CHECK (auth.uid() = seller_id);
CREATE POLICY "mkt_update_own"   ON public.marketplace FOR UPDATE USING (auth.uid() = seller_id);

-- Weapons
CREATE POLICY "wpn_select_own"   ON public.weapons FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "wpn_insert_own"   ON public.weapons FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "wpn_update_own"   ON public.weapons FOR UPDATE USING (auth.uid() = user_id);

-- Plants: public read-only
CREATE POLICY "plants_select_all" ON public.plants FOR SELECT USING (TRUE);
CREATE POLICY "quests_select_all" ON public.quests FOR SELECT USING (TRUE);

-- ============================================================
-- TRIGGER: auto-create user profile on auth signup
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, username)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email,'@',1))
  );
  -- Create empty farm slots 0-9
  INSERT INTO public.farm_slots (user_id, slot_index)
  SELECT NEW.id, generate_series(0, 9);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- TRIGGER: update users.updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- SEED: plants master data
-- ============================================================
INSERT INTO public.plants (key, name, icon, rarity, base_yield, growth_time, price, unlock_level) VALUES
  ('flower',     'Bunga',        '🌸', 'common',    15,  60,   50,   1),
  ('leaf',       'Daun',         '🍃', 'common',    25,  120,  80,   1),
  ('sun',        'Matahari',     '🌻', 'common',    50,  300,  150,  2),
  ('potato',     'Kentang',      '🥔', 'common',    100, 600,  200,  3),
  ('bamboo',     'Bambu',        '🎋', 'common',    150, 900,  300,  5),
  ('statue',     'Patung',       '🗿', 'rare',      300, 3600, 800,  8),
  ('crystalFlower','Bunga Kristal','💎','rare',     500, 7200, 1500, 10),
  ('moonLeaf',   'Daun Bulan',   '🌙', 'rare',      800, 14400,2500, 12),
  ('goldenSun',  'Matahari Emas','✨', 'epic',      1500,28800,5000, 15),
  ('dragonFruit','Naga Fruit',   '🐉', 'epic',      2500,43200,8000, 18),
  ('phoenixBloom','Phoenix Bloom','🔥','legendary', 5000,86400,15000,25),
  ('godPlant',   'Tanaman Dewa', '👑', 'legendary', 10000,172800,30000,40),
  ('sakuraTree', 'Pohon Sakura', '🌸', 'limited',   2000,14400,0,    1),
  ('rainbowFern','Pakis Pelangi','🌈', 'limited',   3000,21600,0,    1)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- SEED: quests
-- ============================================================
INSERT INTO public.quests (key, title, description, target, reward_coins, reward_xp, stat_key) VALUES
  ('harvest5',   'Panen 5 Tanaman',     'Panen tanaman sebanyak 5x',  5,   150, 50,  'harvests'),
  ('spin10',     'Putar Slot 10x',      'Lakukan spin sebanyak 10x',  10,  300, 100, 'spins'),
  ('plant10',    'Tanam 10 Tanaman',    'Tanam tanaman sebanyak 10x', 10,  200, 75,  'plants'),
  ('marketplace1','Jual di Marketplace','Jual 1 item di marketplace',  1,   500, 150, 'sales')
ON CONFLICT (key) DO NOTHING;
