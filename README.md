# FarmVerde — Backend Architecture Guide

## Arsitektur

```
CLIENT (HTML + JS)
      ↓  (fetch + Supabase JS SDK)
SUPABASE (Auth + PostgreSQL + Realtime)
      ↓  (SECURITY DEFINER / Edge Functions)
EDGE FUNCTIONS (Deno — semua logic sensitif)
```

---

## Setup (5 langkah)

### 1. Buat Supabase Project
- Buka https://supabase.com/dashboard
- New Project → catat URL dan anon key

### 2. Jalankan SQL Schema
```sql
-- Di Supabase SQL Editor, jalankan:
-- 1. schema.sql   → buat semua tabel + RLS + triggers + seed data
-- 2. helpers.sql  → buat RPC functions (increment_inventory, dll)
```

### 3. Deploy Edge Functions
```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF

# Deploy semua functions
npx supabase functions deploy claim-farm-reward
npx supabase functions deploy spin-wheel
npx supabase functions deploy daily-reward
npx supabase functions deploy plant-seed
npx supabase functions deploy marketplace-buy
```

### 4. Set Environment Variables di Edge Functions
Di Supabase Dashboard → Edge Functions → Secrets:
```
SUPABASE_URL = https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY = your_service_role_key  ← JANGAN expose ke client!
```

### 5. Update Config di index.html
```javascript
window.SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
window.SUPABASE_ANON_KEY = 'your_anon_key';  // Ini aman untuk client
```

---

## Struktur File

```
farmverde-backend/
├── index.html              ← Main game UI (Tailwind CSS)
├── schema.sql              ← Database schema + RLS + seed data
├── helpers.sql             ← PostgreSQL RPC functions
├── src/
│   ├── auth.js             ← Supabase Auth module
│   ├── api.js              ← Semua API calls ke Supabase
│   ├── farm.js             ← Farm UI + realtime
│   └── store.js            ← Shop, Gacha, Marketplace
└── functions/
    ├── claim-farm-reward/  ← Harvest validation (server)
    ├── spin-wheel/         ← Spin RNG (server)
    ├── daily-reward/       ← Daily claim cooldown (server)
    ├── plant-seed/         ← Plant validation (server)
    └── marketplace-buy/    ← Trade validation (server)
```

---

## Keamanan

### Yang TIDAK BISA dimanipulasi client:
| Feature | Kenapa Aman |
|---------|-------------|
| Coin balance | UPDATE policy: client TIDAK bisa ubah coins langsung |
| Harvest reward | Edge Function menghitung reward — bukan client |
| Spin result | Crypto.getRandomValues() di server Deno |
| Daily cooldown | Server cek timestamp — bukan localStorage |
| Marketplace price | Server validasi harga sebelum transfer |

### RLS Policies:
- `users`: SELECT/UPDATE own row only; UPDATE tidak bisa ubah `coins`
- `farm_slots`: Full CRUD own rows only  
- `coin_logs`: SELECT only (immutable audit trail)
- `marketplace`: SELECT all active; INSERT/UPDATE own listings only

### Anti-Cheat:
1. **No localStorage** untuk state sensitif
2. **Server-side RNG** dengan `crypto.getRandomValues()`
3. **Timestamp validation** di server untuk harvest/daily
4. **Atomic transactions** — coin deducted dan reward given bersamaan
5. **Coin audit trail** via `coin_logs` (immutable)

---

## Realtime Subscriptions

```javascript
// Farm slots update otomatis
supabase.channel('farm:userId')
  .on('postgres_changes', { event: '*', table: 'farm_slots' }, handler)
  .subscribe();
```

---

## Economy Balancing

| Rarity   | Yield Multiplier | Example Plant     |
|----------|-----------------|-------------------|
| Common   | 1x              | Bunga (15 koin)   |
| Rare     | 2x              | Bunga Kristal     |
| Epic     | 5x              | Matahari Emas     |
| Legendary| 10x             | Phoenix Bloom     |
| Limited  | 8x              | Pohon Sakura      |

Overtime bonus: menunggu 2x waktu tumbuh → dapat 2x reward.

---

## Deployment

Untuk production, serve file statis dari:
- Vercel / Netlify (gratis, drag-and-drop `index.html`)
- Atau Supabase Storage dengan custom domain
