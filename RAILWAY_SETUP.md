# 🚀 NgomeAI Railway Deployment Guide

Aplikasi ini **memerlukan PostgreSQL dan Redis** untuk berjalan.

---

## ⚙️ Setup di Railway (Step-by-Step)

### **Langkah 1: Buat Project Baru**
1. Buka https://railway.app/dashboard
2. Klik **"New Project"**
3. Pilih **"Deploy from GitHub repo"**
4. Authorize GitHub → pilih repo **`wimxwim/ngomeai-railway`**
5. Klik **"Deploy Now"**

---

### **Langkah 2: Tunggu Build Selesai**
- Build akan gagal dengan error `Missing env: DATABASE_URL` ✅ (NORMAL)
- Ini expected karena kita belum setup database

---

### **Langkah 3: Tambah PostgreSQL Service**
1. Di project canvas, klik **"+ Add Service"**
2. Pilih **"Database"** → **"PostgreSQL"**
3. Tunggu hingga selesai (2-3 menit)
4. PostgreSQL service akan otomatis link ke ngomeai-railway

---

### **Langkah 4: Tambah Redis Service**
1. Klik **"+ Add Service"** lagi
2. Pilih **"Database"** → **"Redis"**
3. Tunggu hingga selesai

---

### **Langkah 5: Set Environment Variables**
Di service **ngomeai-railway**:

1. Tab **"Variables"**
2. Klik **"RAW EDITOR"** dan paste:

```env
NODE_ENV=production
LOG_LEVEL=info
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=false

DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}

ADMIN_USERNAME=admin
ADMIN_PASSWORD=YOUR_SECURE_PASSWORD_HERE
ADMIN_JWT_SECRET=YOUR_32_CHAR_RANDOM_STRING_HERE

META_VERIFY_TOKEN=YOUR_META_VERIFY_TOKEN
META_APP_SECRET=YOUR_META_APP_SECRET

OPENROUTER_KEY=sk-or-v1-YOUR_OPENROUTER_API_KEY
OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
OPENROUTER_FALLBACK_MODELS=openai/gpt-oss-120b:free,google/gemma-4-31b-it:free,openrouter/free

BAILEYS_SESSIONS_DIR=/data/baileys_sessions
```

3. Ganti yang `YOUR_*` dengan nilai aslimu
4. Klik **"Save"** → auto-redeploy

---

### **Langkah 6: Tunggu Deployment Selesai**
- Cek **"Deployments"** tab
- Status harus **"Building"** → **"Running"** (hijau) ✅

---

### **Langkah 7: Run Database Migrations**
1. Di service ngomeai-railway → tab **"Settings"**
2. Klik **"Connect"** (buka shell)
3. Jalankan:
```bash
npm run db:init
npm run db:migrate
```
4. Tunggu hingga selesai

---

### **Langkah 8: Verifikasi**
1. Klik **"Generate Domain"** di Settings
2. Buka: `https://YOUR-DOMAIN.up.railway.app/health`
3. Harus return: `{"status":"ok","db":"ok"}` ✅

---

## 🔐 API Keys Mana Yang Perlu?

| Key | Wajib? | Dari |
|-----|--------|------|
| `ADMIN_PASSWORD` | ✅ YES | Buat sendiri (min 8 char) |
| `ADMIN_JWT_SECRET` | ✅ YES | Random string 32 char |
| `DATABASE_URL` | ✅ YES | Auto dari PostgreSQL |
| `REDIS_URL` | ✅ YES | Auto dari Redis |
| `OPENROUTER_KEY` | ⚠️ OPTIONAL | https://openrouter.ai |
| `META_VERIFY_TOKEN` | ⚠️ OPTIONAL | Facebook/Meta |
| `META_APP_SECRET` | ⚠️ OPTIONAL | Facebook/Meta |

---

## 🆘 Troubleshooting

### **"Missing env: DATABASE_URL"**
→ Belum setup PostgreSQL atau belum set variables. Lakukan Langkah 2-5 di atas.

### **"Connection refused" ke database**
→ PostgreSQL service belum fully started. Tunggu 2-3 menit.

### **Build gagal di npm ci**
→ Node.js version mismatch. Pastikan package.json memiliki `"node": ">=20"`.

### **Health check timeout**
→ Database belum diinisialisasi. Jalankan `npm run db:init` dan `npm run db:migrate`.

---

## 📱 Menggunakan Aplikasi

Setelah berhasil deploy:

1. **Admin Panel**: `https://YOUR-DOMAIN.up.railway.app/admin`
   - Username: `admin`
   - Password: yang kamu atur di `ADMIN_PASSWORD`

2. **API Health Check**: `https://YOUR-DOMAIN.up.railway.app/health`

3. **Webhook Endpoints**:
   - Meta: `POST https://YOUR-DOMAIN.up.railway.app/webhook`
   - GoWA: `POST https://YOUR-DOMAIN.up.railway.app/webhook/gowa`
   - WaHA: `POST https://YOUR-DOMAIN.up.railway.app/webhook/waha`

---

## 💡 Tips

- Gunakan **free models** dari OpenRouter untuk testing (tidak perlu bayar)
- Setup **WhatsApp provider** baru di admin panel setelah deploy berhasil
- Backup database secara berkala!

---

*Dibuat untuk NgomeAI v2.6.1 - 12 Mei 2026*
