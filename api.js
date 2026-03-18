// api.js — Supabase API layer
// All server communication goes through here
// NEVER manipulate game state directly in client

import { supabase } from './auth.js';

const FUNCTIONS_URL = `${import.meta.env?.VITE_SUPABASE_URL ?? window.SUPABASE_URL}/functions/v1`;

// ──────────────────────────────────────────
// Helper: call an Edge Function with auth
// ──────────────────────────────────────────
async function callFunction(name, body = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Server error');
  return data;
}

// ──────────────────────────────────────────
// USER
// ──────────────────────────────────────────
export async function fetchUserProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .single();
  if (error) throw error;
  return data;
}

// ──────────────────────────────────────────
// FARM
// ──────────────────────────────────────────
export async function fetchFarmSlots() {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('farm_slots')
    .select('*, plant:plant_key(key,name,icon,rarity,base_yield,growth_time)')
    .eq('user_id', user.id)
    .order('slot_index');
  if (error) throw error;
  return data;
}

export async function plantSeed(slotIndex, plantKey) {
  return callFunction('plant-seed', { slot_index: slotIndex, plant_key: plantKey });
}

export async function claimFarmReward(slotIndex) {
  return callFunction('claim-farm-reward', { slot_index: slotIndex });
}

export async function buyPlant(plantKey) {
  const { data: plant } = await supabase
    .from('plants').select('price').eq('key', plantKey).single();
  if (!plant) throw new Error('Plant not found');

  // Server deducts coins and adds to inventory
  const { data, error } = await supabase.rpc('buy_plant_from_shop', {
    p_plant_key: plantKey,
  });
  if (error) throw error;
  return data;
}

// ──────────────────────────────────────────
// INVENTORY
// ──────────────────────────────────────────
export async function fetchInventory() {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('inventory')
    .select('*, plant:plant_key(key,name,icon,rarity,base_yield,growth_time,price)')
    .eq('user_id', user.id)
    .gt('quantity', 0);
  if (error) throw error;
  return data;
}

// ──────────────────────────────────────────
// SPIN
// ──────────────────────────────────────────
export async function spinWheel(spinType = 'coin', bet = 10) {
  return callFunction('spin-wheel', { spin_type: spinType, bet });
}

// ──────────────────────────────────────────
// DAILY REWARD
// ──────────────────────────────────────────
export async function claimDailyReward() {
  return callFunction('daily-reward', {});
}

// ──────────────────────────────────────────
// QUESTS
// ──────────────────────────────────────────
export async function fetchQuests() {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('quests')
    .select(`*, progress:quest_progress!quest_progress_quest_key_fkey(
      progress, completed, claimed
    )`)
    .limit(10);
  if (error) throw error;
  return data;
}

export async function claimQuestReward(questKey) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.rpc('claim_quest_reward', {
    p_user_id: user.id,
    p_quest_key: questKey,
  });
  if (error) throw error;
  return data;
}

// ──────────────────────────────────────────
// MARKETPLACE
// ──────────────────────────────────────────
export async function fetchMarketplace() {
  const { data, error } = await supabase
    .from('marketplace')
    .select('*, seller:seller_id(username), plant:plant_key(name,icon,rarity)')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

export async function listOnMarketplace(plantKey, quantity, price) {
  const { data: { user } } = await supabase.auth.getUser();
  // Server validates via RLS — seller_id must match auth.uid()
  const { data, error } = await supabase.from('marketplace').insert({
    seller_id: user.id,
    plant_key: plantKey,
    quantity,
    price,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function buyFromMarketplace(listingId) {
  return callFunction('marketplace-buy', { listing_id: listingId });
}

// ──────────────────────────────────────────
// GACHA
// ──────────────────────────────────────────
export async function openGachaBox(boxType = 'plant') {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.rpc('open_gacha_box', {
    p_user_id: user.id,
    p_box_type: boxType,
  });
  if (error) throw error;
  return data;
}

// ──────────────────────────────────────────
// PLANTS (master data — cached)
// ──────────────────────────────────────────
let _plantsCache = null;
export async function fetchPlants() {
  if (_plantsCache) return _plantsCache;
  const { data, error } = await supabase.from('plants').select('*').order('unlock_level');
  if (error) throw error;
  _plantsCache = data;
  return data;
}

// ──────────────────────────────────────────
// REALTIME SUBSCRIPTIONS
// ──────────────────────────────────────────
export function subscribeToUser(userId, onUpdate) {
  return supabase
    .channel(`user:${userId}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'users', filter: `id=eq.${userId}`,
    }, onUpdate)
    .subscribe();
}

export function subscribeToFarm(userId, onUpdate) {
  return supabase
    .channel(`farm:${userId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'farm_slots', filter: `user_id=eq.${userId}`,
    }, onUpdate)
    .subscribe();
}

export function subscribeToInventory(userId, onUpdate) {
  return supabase
    .channel(`inventory:${userId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'inventory', filter: `user_id=eq.${userId}`,
    }, onUpdate)
    .subscribe();
}
