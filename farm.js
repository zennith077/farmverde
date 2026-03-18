// farm.js — Farming system UI + logic

import * as api from './api.js';

// In-memory state cache (NOT source of truth — Supabase is)
let _farmState = {
  slots: [],
  user: null,
  inventory: [],
  plants: [],
};

let _realtimeSubs = [];

// ──────────────────────────────────────────
// Init
// ──────────────────────────────────────────
export async function initFarm(userId) {
  try {
    const [slots, inventory, plants, user] = await Promise.all([
      api.fetchFarmSlots(),
      api.fetchInventory(),
      api.fetchPlants(),
      api.fetchUserProfile(),
    ]);

    _farmState = { slots, inventory, plants, user };
    renderFarm();
    renderInventory();
    renderHUD();

    // Subscribe to realtime
    _realtimeSubs.forEach(s => s.unsubscribe());
    _realtimeSubs = [
      api.subscribeToFarm(userId, handleFarmUpdate),
      api.subscribeToInventory(userId, handleInventoryUpdate),
      api.subscribeToUser(userId, handleUserUpdate),
    ];

    return _farmState;
  } catch (err) {
    showError('Gagal memuat farm: ' + err.message);
  }
}

// ──────────────────────────────────────────
// Realtime handlers
// ──────────────────────────────────────────
function handleFarmUpdate(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === 'UPDATE') {
    const idx = _farmState.slots.findIndex(s => s.id === newRow.id);
    if (idx >= 0) _farmState.slots[idx] = { ..._farmState.slots[idx], ...newRow };
  }
  renderFarm();
}

function handleInventoryUpdate(payload) {
  const { eventType, new: newRow } = payload;
  const idx = _farmState.inventory.findIndex(i => i.plant_key === newRow?.plant_key);
  if (idx >= 0) {
    _farmState.inventory[idx] = { ..._farmState.inventory[idx], ...newRow };
  } else if (eventType === 'INSERT') {
    _farmState.inventory.push(newRow);
  }
  renderInventory();
}

function handleUserUpdate(payload) {
  _farmState.user = { ..._farmState.user, ...payload.new };
  renderHUD();
}

// ──────────────────────────────────────────
// Actions
// ──────────────────────────────────────────
export async function handlePlantClick(slotIndex) {
  const slot = _farmState.slots[slotIndex];
  if (!slot) return;

  if (!slot.plant_key) {
    // Open inventory picker
    showInventoryPicker(slotIndex);
  } else {
    // Check if ready
    const now = Date.now();
    const readyAt = new Date(slot.ready_at).getTime();
    if (now >= readyAt) {
      await harvestSlot(slotIndex);
    } else {
      const secondsLeft = Math.ceil((readyAt - now) / 1000);
      showToast(`Belum siap — ${formatTime(secondsLeft)} lagi`);
    }
  }
}

export async function harvestSlot(slotIndex) {
  const btn = document.getElementById(`slot-${slotIndex}`);
  if (btn) btn.classList.add('harvesting');

  try {
    const result = await api.claimFarmReward(slotIndex);
    showCoinFly(result.reward, btn);
    showToast(`+${result.reward.toLocaleString()} koin! +${result.xp_gained} XP`);

    // Update local cache optimistically
    const slotIdx = _farmState.slots.findIndex(s => s.slot_index === slotIndex);
    if (slotIdx >= 0) {
      _farmState.slots[slotIdx] = {
        ..._farmState.slots[slotIdx],
        plant_key: null, planted_at: null, ready_at: null, plant: null,
      };
    }
    _farmState.user.coins = result.new_coins;
    _farmState.user.xp = result.new_xp;
    _farmState.user.level = result.new_level;

    renderFarm();
    renderHUD();
  } catch (err) {
    showError(err.message);
  } finally {
    if (btn) btn.classList.remove('harvesting');
  }
}

export async function plantInSlot(slotIndex, plantKey) {
  try {
    const result = await api.plantSeed(slotIndex, plantKey);

    // Update local cache
    const slotIdx = _farmState.slots.findIndex(s => s.slot_index === slotIndex);
    const plantData = _farmState.plants.find(p => p.key === plantKey);
    if (slotIdx >= 0) {
      _farmState.slots[slotIdx] = {
        ..._farmState.slots[slotIdx],
        plant_key: plantKey,
        planted_at: result.planted_at,
        ready_at: result.ready_at,
        plant: plantData,
      };
    }
    // Deduct inventory
    const invIdx = _farmState.inventory.findIndex(i => i.plant_key === plantKey);
    if (invIdx >= 0) {
      _farmState.inventory[invIdx].quantity -= 1;
      if (_farmState.inventory[invIdx].quantity <= 0) {
        _farmState.inventory.splice(invIdx, 1);
      }
    }

    closeModal('invModal');
    renderFarm();
    renderInventory();
    showToast(`${plantData?.icon ?? '🌱'} ${plantData?.name ?? plantKey} ditanam!`);
  } catch (err) {
    showError(err.message);
  }
}

// ──────────────────────────────────────────
// RENDER
// ──────────────────────────────────────────
export function renderFarm() {
  const grid = document.getElementById('farmGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const now = Date.now();

  _farmState.slots.forEach(slot => {
    const div = document.createElement('div');
    div.className = 'plot';
    div.id = `slot-${slot.slot_index}`;

    if (!slot.plant_key) {
      div.classList.add('empty');
      div.innerHTML = '<div class="plot-empty-icon">＋</div>';
      div.onclick = () => handlePlantClick(slot.slot_index);
    } else {
      const plant = slot.plant;
      const readyAt = new Date(slot.ready_at).getTime();
      const plantedAt = new Date(slot.planted_at).getTime();
      const totalTime = readyAt - plantedAt;
      const elapsed = now - plantedAt;
      const progress = Math.min(elapsed / totalTime, 1);
      const isReady = now >= readyAt;
      const stage = progress < 0.3 ? 'seed' : progress < 0.7 ? 'growing' : 'grown';

      div.classList.add('planted', `stage-${stage}`, isReady ? 'ready' : 'growing');
      div.innerHTML = `
        <div class="plot-icon" style="font-size:${1.4 + progress * 0.6}rem">
          ${plant?.icon ?? '🌱'}
        </div>
        <div class="plot-progress-bar">
          <div class="plot-progress-fill" style="width:${progress * 100}%"></div>
        </div>
        ${isReady
          ? '<div class="plot-ready-badge">PANEN!</div>'
          : `<div class="plot-timer">${formatTime(Math.ceil((readyAt - now) / 1000))}</div>`
        }
      `;
      div.onclick = () => handlePlantClick(slot.slot_index);
    }

    grid.appendChild(div);
  });

  // Start timer if any slot is growing
  const anyGrowing = _farmState.slots.some(s => s.plant_key && Date.now() < new Date(s.ready_at).getTime());
  if (anyGrowing) {
    setTimeout(renderFarm, 1000);
  }
}

export function renderHUD() {
  const u = _farmState.user;
  if (!u) return;
  const _set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  _set('coinDisplay', (u.coins ?? 0).toLocaleString());
  _set('levelDisplay', `Lv ${u.level ?? 1}`);

  // XP bar
  const xpFill = document.getElementById('xpFill');
  if (xpFill) {
    const pct = getXpPercent(u.xp ?? 0, u.level ?? 1);
    xpFill.style.width = pct + '%';
  }
}

export function renderInventory() {
  const grid = document.getElementById('invGrid');
  if (!grid) return;
  const items = _farmState.inventory.filter(i => i.quantity > 0);
  if (!items.length) {
    grid.innerHTML = '<div class="empty-state">Inventori kosong. Beli tanaman di toko!</div>';
    return;
  }
  grid.innerHTML = items.map(item => `
    <div class="inv-item rarity-${item.plant?.rarity ?? 'common'}" 
         onclick="window._selectPlant && window._selectPlant('${item.plant_key}')">
      <div class="inv-icon">${item.plant?.icon ?? '🌱'}</div>
      <div class="inv-name">${item.plant?.name ?? item.plant_key}</div>
      <div class="inv-qty">x${item.quantity}</div>
    </div>
  `).join('');
}

// ──────────────────────────────────────────
// Inventory picker modal
// ──────────────────────────────────────────
let _pendingSlot = null;

function showInventoryPicker(slotIndex) {
  _pendingSlot = slotIndex;
  const modal = document.getElementById('invModal');
  if (modal) modal.classList.add('open');

  window._selectPlant = (plantKey) => {
    if (_pendingSlot !== null) {
      plantInSlot(_pendingSlot, plantKey);
      _pendingSlot = null;
    }
  };

  renderInventory();
}

// ──────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────
function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function getXpPercent(xp, level) {
  let threshold = 100;
  let cumulative = 0;
  for (let l = 1; l < level; l++) {
    cumulative += threshold;
    threshold = Math.floor(threshold * 1.5);
  }
  const levelXp = xp - cumulative;
  return Math.min((levelXp / threshold) * 100, 100);
}

function showCoinFly(amount, target) {
  const el = document.createElement('div');
  el.className = 'coin-fly';
  el.textContent = `+${amount.toLocaleString()}🪙`;
  if (target) {
    const rect = target.getBoundingClientRect();
    el.style.left = rect.left + rect.width / 2 + 'px';
    el.style.top = rect.top + 'px';
  }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (t) { t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
}

function showError(msg) {
  showToast('⚠ ' + msg);
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
}
