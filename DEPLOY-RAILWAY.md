# 🚀 Panduan Deploy NgomeAI ke Railway

## Persiapan (5 menit)

### 1. Push ke GitHub
```bash
cd /home/ngome/Desktop/ngomeai-railway
git init
git add .
git commit -m "NgomeAI Railway ready"
git remote add origin https://github.com/USERNAME/ngomeai-railway.git
git push -u origin main
```

### 2. Buat Project di Railway
1. Buka https://railway.app → **New Project**
2. Pilih **"Deploy from GitHub repo"**
3. Pilih repo `ngomeai-railway`
4. Railway otomatis detect Node.js ✅

---

## Tambah Services

### PostgreSQL
1. Di Railway dashboard → **"Add Service"** → **"Database"** → **"PostgreSQL"**
2. Railway otomatis inject `DATABASE_URL` ke project

### Redis  
1. **"Add Service"** → **"Database"** → **"Redis"**
2. Railway otomatis inject `REDIS_URL` ke project

---

## Set Environment Variables

Pergi ke project → **"Variables"** → tambahkan semua dari file `.env.railway`:

| Variable | Nilai |
|----------|-------|
| `NODE_ENV` | `production` |
| `DB_SSL` | `true` |
| `DB_SSL_REJECT_UNAUTHORIZED` | `false` |
| `ADMIN_PASSWORD` | password kuat min 8 karakter |
| `ADMIN_JWT_SECRET` | random string min 32 karakter |
| `META_VERIFY_TOKEN` | bebas, tapi wajib diisi |
| `META_APP_SECRET` | bebas, tapi wajib diisi |
| `OPENROUTER_KEY` | API key dari openrouter.ai |

> `DATABASE_URL`, `REDIS_URL`, dan `PORT` di-inject otomatis oleh Railway.

---

## Setup Baileys Sessions (Persistent)

Agar session WhatsApp tidak hilang saat redeploy:

1. Railway dashboard → project → **"Volumes"**
2. Klik **"Add Volume"**
3. Mount path: `/data/baileys_sessions`
4. Tambah env var: `BAILEYS_SESSIONS_DIR=/data/baileys_sessions`

---

## Jalankan Migrations (Sekali, setelah deploy pertama)

1. Railway dashboard → project → klik service NgomeAI
2. Tab **"Settings"** → **"Connect"** → **"Railway CLI Shell"**
3. Jalankan:
```bash
npm run db:init
npm run db:migrate
```

Atau via Railway CLI di terminal lokal:
```bash
npm install -g @railway/cli
railway login
railway run npm run db:init
railway run npm run db:migrate
```

---

## Verifikasi Berhasil

Setelah deploy, cek health endpoint:
```
https://YOUR-APP.up.railway.app/health
```

Response yang benar:
```json
{"status":"ok","db":"ok"}
```

---

## Akses Admin Panel
```
https://YOUR-APP.up.railway.app/admin
```
Login dengan `ADMIN_PASSWORD` yang sudah diset.

---

## Troubleshooting

| Error | Solusi |
|-------|--------|
| `STARTUP BLOCKED: META_APP_SECRET` | Isi `META_APP_SECRET` di env vars |
| `ADMIN_PASSWORD` error | Min 8 karakter |
| `ADMIN_JWT_SECRET` error | Min 32 karakter |
| DB connection error | Pastikan PostgreSQL service sudah linked, `DB_SSL=true` |
| Redis error | Tidak masalah — ada fallback in-memory otomatis |
| Baileys session hilang setelah deploy | Setup Railway Volume (lihat section Baileys) |
