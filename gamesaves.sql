-- ================================================================
-- FARMVERDE — game_saves table
-- Jalankan ini di Supabase SQL Editor SETELAH farmverde_complete.sql
-- ================================================================

-- Tabel penyimpanan data game per user
CREATE TABLE IF NOT EXISTS public.game_saves (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  game_data  JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Row Level Security — setiap user hanya bisa akses data sendiri
ALTER TABLE public.game_saves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own_save_all" ON public.game_saves;
CREATE POLICY "own_save_all" ON public.game_saves
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Trigger untuk auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_game_save_ts()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS game_save_updated_at ON public.game_saves;
CREATE TRIGGER game_save_updated_at
  BEFORE UPDATE ON public.game_saves
  FOR EACH ROW EXECUTE FUNCTION public.update_game_save_ts();

-- Index untuk query cepat
CREATE INDEX IF NOT EXISTS idx_game_saves_user ON public.game_saves(user_id);

-- ================================================================
-- SELESAI
-- Sekarang data game tersimpan di server, bukan localStorage saja.
-- ================================================================
