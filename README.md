# NgomeAI — WhatsApp Chatbot Engine

Backend engine WhatsApp AI multi-tenant berbasis Node.js + PostgreSQL.
Satu server bisa melayani banyak klien/bisnis sekaligus, masing-masing terisolasi penuh.

**Stack:** Node.js 18+ · Express 4 · PostgreSQL 16 · Redis · OpenRouter AI · Baileys · PM2 · Nginx

---

## Struktur Folder

```
ngomeai-codeengine/
│
├── src/                          ← SELURUH SOURCE CODE APLIKASI
│   ├── index.js                  ← Entry point, startup server + scheduler
│   ├── app.js                    ← Express app, middleware, routing
│   ├── config.js                 ← Semua env variable + validasi
│   ├── db.js                     ← PostgreSQL connection pool
│   │
│   ├── orchestrator/
│   │   └── orchestrator.js       ← Pipeline utama pesan masuk (dedup → AI → kirim)
│   │
│   ├── ai/
│   │   ├── ai.js                 ← OpenRouter AI + injeksi profil bisnis
│   │   ├── modelSelector.js      ← Baca & cache model chain
│   │   └── modelTracker.js       ← Tracking performa model
│   │
│   ├── providers/
│   │   ├── baileys.js            ← WhatsApp Baileys (multi-session, in-process)
│   │   ├── meta.js               ← Meta Cloud API (official WhatsApp Business)
│   │   └── sender.js             ← Abstraksi kirim pesan (text/image/file/audio/lokasi)
│   │
│   ├── api/
│   │   ├── webhook.js            ← Endpoint inbound dari WhatsApp provider
│   │   ├── admin.js              ← REST API admin (clients, template, KB, stats)
│   │   └── onboard.js            ← API onboarding klien baru
│   │
│   ├── repositories/
│   │   ├── logic.js              ← Query DB: dedup, rate limit, quota, template, KB
│   │   ├── admin.js              ← Query DB: CRUD clients, templates, KB, history, stats
│   │   └── conversationState.js  ← State percakapan per user
│   │
│   ├── middleware/
│   │   ├── adminAuth.js          ← JWT Bearer auth + token blacklist Redis
│   │   └── requestId.js          ← Inject request ID unik ke setiap request
│   │
│   ├── bots/
│   │   └── telegram.js           ← Admin bot Telegram (test AI, CRUD, stats)
│   │
│   ├── actions/
│   │   ├── index.js              ← Router eksekusi action dari AI
│   │   ├── sendText.js           ← Action kirim teks
│   │   ├── sendImage.js          ← Action kirim gambar
│   │   ├── sendAudio.js          ← Action kirim audio
│   │   ├── sendFile.js           ← Action kirim file/dokumen
│   │   ├── sendLocation.js       ← Action kirim lokasi
│   │   └── sendTyping.js         ← Action kirim indikator mengetik
│   │
│   ├── skills/
│   │   ├── index.js              ← Router eksekusi skill dari intent AI
│   │   └── leadCapture.js        ← Skill: simpan data lead/prospek
│   │
│   ├── templates/
│   │   └── index.js              ← Pencarian template FAQ (keyword matching)
│   │
│   ├── workers/
│   │   ├── autoKbWorker.js       ← Auto-generate Knowledge Base dari history (00.00 & 12.00)
│   │   ├── followUp.js           ← Scheduler follow-up pesan terjadwal
│   │   ├── healthCheck.js        ← Monitor kesehatan koneksi WhatsApp
│   │   ├── modelBenchmark.js     ← Benchmark model AI tiap malam
│   │   ├── sessionCleanup.js     ← Cleanup session expired
│   │   └── statsWorker.js        ← Hitung statistik dashboard
│   │
│   ├── utils/
│   │   ├── antispam.js           ← Deteksi flood & pesan duplikat masuk
│   │   ├── hmac.js               ← Verifikasi HMAC-SHA256 webhook
│   │   ├── logger.js             ← JSON logger (level dari LOG_LEVEL env)
│   │   ├── moderation.js         ← Filter konten sensitif / hard block
│   │   ├── redis.js              ← Redis client + fallback in-memory
│   │   └── urlGuard.js           ← SSRF prevention (blokir URL private IP)
│   │
│   └── scripts/
│       ├── init-db.js            ← Jalankan schema.sql ke DB (setup awal)
│       ├── seed-demo.js          ← Insert data demo (dev only)
│       └── test-webhook.js       ← Kirim test webhook ke server lokal
│
├── sql/                          ← SCHEMA & MIGRATION DATABASE
│   ├── schema.sql                ← Struktur tabel awal
│   ├── migration_001_*.sql       ← Processed messages (dedup)
│   ├── migration_002_*.sql       ← Provider + system prompt
│   ├── migration_003_*.sql       ← Audit log
│   ├── migration_004_*.sql       ← GoWA provider
│   ├── migration_005_*.sql       ← Conversation state
│   ├── migration_006_*.sql       ← WaHA provider
│   ├── migration_007_*.sql       ← Reply mode
│   ├── migration_008_*.sql       ← Chat history fields
│   ├── migration_009_*.sql       ← Approval workflow
│   ├── migration_010_*.sql       ← Direction (in/out)
│   ├── migration_011_*.sql       ← Listen mode (personal & group)
│   ├── migration_012_*.sql       ← WaHA URL
│   ├── migration_013_*.sql       ← pg_trgm untuk KB search
│   ├── migration_014_*.sql       ← Health status
│   ├── migration_015_*.sql       ← Follow-up scheduler
│   ├── migration_016_*.sql       ← WaHA webhook secret
│   ├── migration_020_*.sql       ← Evolution API
│   ├── migration_021_*.sql       ← Baileys provider
│   ├── migration_022_*.sql       ← Hapus GoWA/WaHA, tambah business_type
│   ├── migration_023_*.sql       ← Index performa (direction, stats, KB)
│   └── migration_024_*.sql       ← Kolom business_profile per klien
│
├── public/                       ← ADMIN UI (HTML + CSS + JS)
│   ├── admin/
│   │   ├── dashboard.html        ← Halaman utama: statistik & grafik
│   │   ├── clients.html          ← Manajemen klien (tambah/edit/hapus)
│   │   ├── history.html          ← Riwayat chat (filter, approval workflow)
│   │   ├── templates.html        ← Template FAQ keyword-based
│   │   ├── kb.html               ← Knowledge Base + auto-KB approval
│   │   ├── stats.html            ← Statistik detail per klien
│   │   ├── index.html            ← Layout utama admin panel
│   │   ├── css/style.css         ← Stylesheet global admin
│   │   └── js/
│   │       ├── api.js            ← Wrapper fetch ke backend API
│   │       ├── app.js            ← Logic utama admin panel
│   │       ├── auth.js           ← Guard JWT + auto-logout
│   │       └── login.js          ← Halaman login
│   ├── admin.html                ← Redirect ke /admin/
│   ├── index.html                ← Halaman publik (landing)
│   └── qr.html                  ← Tampilan QR code scan WhatsApp
│
├── tests/                        ← INTEGRATION TEST
│   ├── dedup.test.js             ← Test deduplication pesan
│   ├── quota.test.js             ← Test atomicity quota AI
│   └── webhook.test.js           ← Test end-to-end webhook
│
├── data/
│   └── model_chain.json          ← Urutan & score model AI (hasil benchmark)
│
├── nginx/
│   └── chatbot.conf              ← Konfigurasi Nginx reverse proxy
│
├── package.json                  ← Dependencies Node.js
├── package-lock.json             ← Lock file versi exact
├── .env.example                  ← Template konfigurasi (TANPA password/secret)
├── .gitignore                    ← File yang tidak di-commit (node_modules, .env, dll)
├── docker-compose.yml            ← PostgreSQL via Docker (development)
└── ecosystem.config.js           ← Konfigurasi PM2 (production cluster)
```

---

## Cara Instalasi

### 1. Prasyarat
- Node.js 18+
- PostgreSQL 16+ (atau Docker)
- Redis (opsional, fallback in-memory tersedia)

### 2. Setup pertama kali

```bash
# Clone / ekstrak project
cd codeengine-node-postgres

# Install dependencies
npm install

# Salin template environment
cp .env.example .env
# Edit .env — isi DATABASE_URL, ADMIN_PASSWORD, ADMIN_JWT_SECRET, OPENROUTER_KEY, dll

# Jalankan PostgreSQL via Docker
npm run db:up

# Buat tabel
npm run db:init

# Jalankan semua migration (001–024)
npm run db:migrate

# (Opsional) Insert data demo
npm run db:seed
```

### 3. Jalankan server

```bash
# Development (auto-reload)
npm run dev

# Production
npm start

# Production dengan PM2 cluster
pm2 start ecosystem.config.js
```

### 4. Jalankan test

```bash
npm test
```

---

## Konfigurasi Wajib (.env)

| Variable | Keterangan |
|----------|-----------|
| `DATABASE_URL` | PostgreSQL connection string |
| `ADMIN_PASSWORD` | Password login admin (min 8 karakter) |
| `ADMIN_JWT_SECRET` | Secret JWT admin (min 32 karakter) |
| `OPENROUTER_KEY` | API key OpenRouter untuk AI |
| `REDIS_HOST` | Host Redis (default: 127.0.0.1) |
| `PORT` | Port server (default: 3000) |

Lihat `.env.example` untuk daftar lengkap.

---

## Alur Kerja Pesan

```
Pesan Masuk (WhatsApp)
        ↓
   [Deduplication]        ← Cegah proses pesan ganda
        ↓
   [Rate Limit]           ← Maks 5 pesan/menit per nomor
        ↓
   [Anti-spam / Flood]    ← Deteksi banjir pesan
        ↓
   [Template Match]       ← Jawab dari FAQ keyword? → kirim
        ↓
   [Knowledge Base]       ← Ada di KB? → kirim
        ↓
   [AI (OpenRouter)]      ← Fallback: tanya AI dengan profil bisnis sebagai konteks
        ↓
   [Execute Actions]      ← Kirim teks/gambar/file/lokasi ke WhatsApp
        ↓
   [Simpan History]       ← Catat ke database
```

---

## Fitur Utama

| Fitur | Keterangan |
|-------|-----------|
| Multi-klien | Satu server, banyak nomor WhatsApp |
| Multi-provider | Baileys (in-process), Meta Cloud API |
| AI fallback chain | Coba 3 model AI, auto-ganti jika gagal |
| Profil bisnis | Data bisnis diinjeksi ke konteks AI per klien |
| Business type | Tone AI otomatis: masjid=islami, toko=jualan, dll |
| Listen mode | AI simpan ke DB tanpa kirim ke WA |
| Approval workflow | Pesan AI di-review admin sebelum terkirim |
| Auto Knowledge Base | Generate KB dari history setiap 00.00 & 12.00 |
| Follow-up scheduler | Kirim pesan terjadwal otomatis |
| Admin panel | Dashboard, history, KB, template, stats |
| Telegram bot | Kontrol via Telegram (/test, /stats, /clients) |
| Anti-spam | Flood detection + blacklist sementara |
| SSRF prevention | URL media divalidasi sebelum download |
| Redis caching | Client, session, rate limit, AI response |

---

## Provider WhatsApp

| Provider | Status | Keterangan |
|----------|--------|-----------|
| **Baileys** | ✅ Aktif | In-process, multi-session, scan QR |
| **Meta Cloud API** | ✅ Aktif | Official, butuh akun bisnis terverifikasi |
| Evolution API | 🔧 Tersedia | Via REST, multi-instance |

---

## Admin Panel

Akses: `http://localhost:PORT/admin`

Login dengan `ADMIN_USERNAME` + `ADMIN_PASSWORD` dari `.env`.

---

## Lisensi

Private — NgomeAI © 2026. Semua hak dilindungi.
