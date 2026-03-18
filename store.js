// store.js — Shop & Marketplace module

import * as api from './api.js';

// ──────────────────────────────────────────
// SHOP
// ──────────────────────────────────────────
export async function renderShop() {
  const grid = document.getElementById('shopGrid');
  if (!grid) return;

  try {
    const [plants, userProfile] = await Promise.all([
      api.fetchPlants(),
      api.fetchUserProfile(),
    ]);

    grid.innerHTML = plants.map(plant => {
      const canBuy = userProfile.coins >= plant.price && userProfile.level >= plant.unlock_level;
      const locked = userProfile.level < plant.unlock_level;
      return `
        <div class="shop-card rarity-${plant.rarity} ${locked ? 'locked' : ''}">
          <div class="shop-icon">${plant.icon}</div>
          <div class="shop-name">${plant.name}</div>
          <div class="shop-rarity rarity-tag">${plant.rarity.toUpperCase()}</div>
          <div class="shop-yield">+${plant.base_yield.toLocaleString()} koin/panen</div>
          <div class="shop-time">${formatTime(plant.growth_time)}</div>
          ${locked
            ? `<div class="shop-locked">Level ${plant.unlock_level} diperlukan</div>`
            : `<button class="shop-btn ${canBuy ? '' : 'disabled'}"
                       onclick="window._buyPlant('${plant.key}')"
                       ${!canBuy ? 'disabled' : ''}>
                ${plant.price.toLocaleString()} 🪙
               </button>`
          }
        </div>
      `;
    }).join('');

    window._buyPlant = async (plantKey) => {
      try {
        await api.buyPlant(plantKey);
        renderShop();
        showToast('Bibit dibeli!');
      } catch (err) {
        showToast('⚠ ' + err.message);
      }
    };

  } catch (err) {
    grid.innerHTML = `<div class="error">Gagal memuat toko: ${err.message}</div>`;
  }
}

// ──────────────────────────────────────────
// MARKETPLACE
// ──────────────────────────────────────────
export async function renderMarketplace() {
  const list = document.getElementById('marketplaceList');
  if (!list) return;
  list.innerHTML = '<div class="loading">Memuat marketplace…</div>';

  try {
    const [listings, user] = await Promise.all([
      api.fetchMarketplace(),
      api.fetchUserProfile(),
    ]);

    if (!listings.length) {
      list.innerHTML = '<div class="empty-state">Marketplace kosong. Jadilah yang pertama berjualan!</div>';
      return;
    }

    list.innerHTML = listings.map(listing => {
      const isOwn = listing.seller_id === user.id;
      const canBuy = user.coins >= listing.price && !isOwn;
      return `
        <div class="market-item">
          <div class="market-icon">${listing.plant?.icon ?? '🌱'}</div>
          <div class="market-info">
            <div class="market-name">${listing.plant?.name ?? listing.plant_key}</div>
            <div class="market-seller">oleh @${listing.seller?.username ?? 'Unknown'}</div>
            <div class="market-qty">x${listing.quantity}</div>
          </div>
          <div class="market-price">${listing.price.toLocaleString()} 🪙</div>
          ${isOwn
            ? '<div class="market-own-tag">Milikmu</div>'
            : `<button class="market-buy-btn ${canBuy ? '' : 'disabled'}"
                        onclick="window._buyListing('${listing.id}')"
                        ${!canBuy ? 'disabled' : ''}>
                Beli
               </button>`
          }
        </div>
      `;
    }).join('');

    window._buyListing = async (listingId) => {
      try {
        const result = await api.buyFromMarketplace(listingId);
        await renderMarketplace();
        showToast(`Berhasil dibeli! -${result.price_paid.toLocaleString()} koin`);
      } catch (err) {
        showToast('⚠ ' + err.message);
      }
    };

  } catch (err) {
    list.innerHTML = `<div class="error">Gagal memuat: ${err.message}</div>`;
  }
}

export async function openSellModal() {
  const modal = document.getElementById('sellModal');
  if (!modal) return;

  const inventory = await api.fetchInventory();
  const picker = document.getElementById('sellItemPicker');
  if (picker) {
    picker.innerHTML = inventory.filter(i => i.quantity > 0).map(item => `
      <option value="${item.plant_key}" data-qty="${item.quantity}">
        ${item.plant?.icon} ${item.plant?.name} (x${item.quantity})
      </option>
    `).join('');
  }

  modal.classList.add('open');

  document.getElementById('sellConfirmBtn')?.addEventListener('click', async () => {
    const plantKey = document.getElementById('sellItemPicker')?.value;
    const qty = parseInt(document.getElementById('sellQty')?.value ?? '1');
    const price = parseInt(document.getElementById('sellPrice')?.value ?? '0');

    if (!plantKey || qty < 1 || price < 1) {
      showToast('Isi semua data dengan benar');
      return;
    }

    try {
      await api.listOnMarketplace(plantKey, qty, price);
      modal.classList.remove('open');
      await renderMarketplace();
      showToast('Item berhasil dijual di marketplace!');
    } catch (err) {
      showToast('⚠ ' + err.message);
    }
  }, { once: true });
}

// ──────────────────────────────────────────
// GACHA BOX
// ──────────────────────────────────────────
export async function handleGachaOpen(boxType = 'plant') {
  const btn = document.getElementById('gachaOpenBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Membuka…'; }

  try {
    const result = await api.openGachaBox(boxType);
    const plant = result.plant_key;

    // Show result animation
    showGachaResult(plant);
    updateCoinDisplay(result.new_coins);
  } catch (err) {
    showToast('⚠ ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Buka Box (1.000 🪙)'; }
  }
}

function showGachaResult(plantKey) {
  const overlay = document.getElementById('gachaResultOverlay');
  if (!overlay) return;
  overlay.innerHTML = `
    <div class="gacha-result-card">
      <div class="gacha-stars">⭐⭐⭐</div>
      <div class="gacha-icon">🎊</div>
      <div class="gacha-plant-key">${plantKey}</div>
      <button onclick="document.getElementById('gachaResultOverlay').style.display='none'">
        Lanjutkan
      </button>
    </div>
  `;
  overlay.style.display = 'flex';
}

// ──────────────────────────────────────────
// Utils
// ──────────────────────────────────────────
function formatTime(seconds) {
  if (seconds < 60) return `${seconds}d`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}j`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (t) { t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
}

function updateCoinDisplay(coins) {
  const el = document.getElementById('coinDisplay');
  if (el) el.textContent = coins.toLocaleString();
}
