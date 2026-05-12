# NgomeAI CodeEngine — CLAUDE.md

Panduan ini dibuat agar Claude Code (dan AI agent lain) bisa langsung paham
seluruh codebase tanpa perlu baca file satu per satu.

---

## Ringkasan Proyek

WhatsApp chatbot multi-provider berbasis Node.js + PostgreSQL.
Menerima pesan masuk dari **GoWA**, **WaHA**, atau **Meta Cloud API**,
memprosesnya lewat pipeline Template → Knowledge Base → AI (OpenRouter),
lalu mengirim balasan kembali via provider yang sama.

**Stack:** Node.js 18+, Express 4, PostgreSQL 13+, OpenRouter API  
**Entry point:** `src/index.js`  
**Port default:** 3000  
**Test:** `npm test` (node:test built-in, butuh DB aktif)

---

## Struktur File

```
src/
├── index.js                  ← startup, scheduler, graceful shutdown
├── app.js                    ← Express app, middleware, routes
├── config.js                 ← semua env vars, validasi wajib
├── db.js                     ← PostgreSQL pool (pg)
├── middleware/
│   ├── adminAuth.js          ← JWT Bearer auth + token blacklist TTL
│   └── requestId.js          ← inject req.requestId (UUID) ke setiap request
├── routes/
│   ├── webhook.js            ← inbound: Meta POST /webhook, GoWA POST /webhook/gowa, WaHA POST /webhook/waha
│   └── admin.js              ← REST API admin: clients, templates, KB, stats, benchmark
├── services/
│   ├── orchestrator.js       ← PIPELINE UTAMA: dedup → rate limit → template → KB → AI → send
│   ├── sender.js             ← provider abstraction: sendMessage/sendImage/sendAudio/sendFile/sendLocation/sendTyping/markRead
│   ├── gowa.js               ← GoWA REST adapter (go-whatsapp-web-multidevice)
│   ├── waha.js               ← WaHA REST adapter (WhatsApp HTTP API)
│   ├── meta.js               ← Meta Cloud API adapter
│   ├── ai.js                 ← OpenRouter AI dengan model chain fallback, system prompt Kira
│   ├── logic.js              ← DB queries: client cache, dedup, rate limit, template/KB search, quota, history
│   ├── admin.js              ← DB queries untuk admin: CRUD clients/templates/KB/history/stats/audit
│   ├── conversationState.js  ← per-user conversation state (tabel conversations)
│   ├── modelBenchmark.js     ← nightly benchmark semua free model OpenRouter
│   ├── modelSelector.js      ← baca model chain dari data/model_chain.json (cache 60s)
│   └── telegram.js           ← Telegram admin bot (polling, wizard, AI test, CRUD)
├── utils/
│   ├── logger.js             ← JSON logger (console), level dari LOG_LEVEL env
│   └── urlGuard.js           ← isSafeUrl() — blokir private IP / non-http(s)
└── scripts/
    ├── init-db.js            ← jalankan schema.sql ke DB
    ├── seed-demo.js          ← insert demo client + template + KB
    └── test-webhook.js       ← kirim test webhook ke server lokal
```

---

## Provider WhatsApp

### GoWA (`provider = 'gowa'`)
- Binary Go, jalankan terpisah (default port 3001)
- Docs: `chatbot/gowa/readme.md` dan `chatbot/gowa/docs/`
- Webhook masuk: `POST /webhook/gowa`
- Payload: `{ event: "message", device_id: "628xxx@s.whatsapp.net", payload: { id, chat_id, from, body, ... } }`
- Client DB field: `gowa_device_id` (JID device, e.g. `628xxx@s.whatsapp.net`)
- Send API: `POST {GOWA_URL}/send/message` dengan header `X-Device-Id`
- Format phone: `628xxx@s.whatsapp.net` (JID)
- Auth: Basic Auth opsional via `GOWA_BASIC_AUTH`
- Kelebihan: ringan (Go binary), multi-device v8, typing indicator, mark read
- Kekurangan: tidak ada dashboard bawaan, perlu setup manual

### WaHA (`provider = 'waha'`)
- Docker container Node.js + NestJS (default port 3002)
- Docs: https://waha.devlike.pro, source: `chatbot/waha/`
- Webhook masuk: `POST /webhook/waha`
- Payload: `{ id, timestamp, session, engine, event: "message", payload: { id, from, to, fromMe, body, hasMedia, media, ... } }`
- Client DB field: `waha_session` (nama session WaHA, e.g. `default`)
- Send API: `POST {WAHA_URL}/api/{session}/sendText`
- Format phone: `628xxx@c.us` (chatId WaHA)
- Auth: `X-Api-Key` header via `WAHA_API_KEY`
- Kelebihan: dashboard bawaan, multi-engine (WEBJS/NOWEB/GOWS), API lengkap
- Kekurangan: lebih berat (Node.js), butuh Docker

### Meta (`provider = 'meta'`)
- Official Meta Cloud API
- Webhook masuk: `POST /webhook` (dengan HMAC-SHA256 verification)
- Webhook verification: `GET /webhook` (hub.challenge)
- Client DB field: `phone_number_id` + `meta_token`
- Kelebihan: official, stabil, tidak kena ban
- Kekurangan: butuh akun bisnis terverifikasi, proses approval

---

## Pipeline Pesan Masuk (orchestrator.js)

```
handleInboundMessage({ client, userPhone, userMessageRaw, msgId, rid, messageType, mediaCaption })
  1. isMessageProcessed(msgId)     → return jika duplikat (INSERT ON CONFLICT)
  2. checkRateLimit(userPhone)     → return jika > 5 msg/menit
  3. incrementTotalMessages()      → update usage_tracker
  4. markRead(client, msgId)       → GoWA/WaHA only, non-fatal
  5. Non-text?
     - Ada caption → proses caption sebagai teks
     - Tidak ada → kirim "hanya bisa balas teks", save history, return
  6. normalizeInbound(text)        → truncate 2000 char + lowercase
  7. sendTyping(true)              → GoWA/WaHA only, non-fatal
  8. Promise.all([state, history, template, kb, quota])  ← PARALEL
  9. Decision:
     a. template match → pakai template
     b. KB match       → pakai KB
     c. quota habis    → kirim pesan quota
     d. AI             → askAI() dengan model chain
  10. sendTyping(false)
  11. executeActions(decision)     → send_text/send_image/send_audio/send_file/send_location
  12. saveChatHistory()
  13. setConversationState()       → hanya jika AI set next_state
```

---

## AI Engine (ai.js)

- **System prompt default:** Kira — AI asisten WhatsApp NgomeAI (Bahasa Indonesia, JSON output)
- **Model chain:** dibaca dari `data/model_chain.json` via `modelSelector.js` (cache 60s)
- **Fallback:** coba max 3 model dari chain, skip ke berikutnya jika 5xx/timeout
- **Output wajib:** `{ intent, confidence, response, actions, next_state }`
- **Nightly benchmark:** `modelBenchmark.js` test semua free model OpenRouter tiap tengah malam
- **Manual benchmark:** `POST /api/admin/models/benchmark` atau `/benchmark` di Telegram bot

---

## Database Schema

Tabel utama di `sql/schema.sql`:

| Tabel | Kegunaan |
|-------|----------|
| `clients` | Data client WA (provider, token, device_id, session) |
| `templates` | Keyword → jawaban otomatis |
| `knowledge_base` | Keyword → konten KB |
| `chat_history` | Log semua percakapan |
| `usage_tracker` | Quota AI per hari per client |
| `rate_limit` | Rate limit per nomor HP |
| `processed_messages` | Dedup pesan (INSERT ON CONFLICT) |
| `audit_log` | Log semua aksi admin |
| `conversations` | State percakapan per (client, user) |

**Provider constraint:** `CHECK (provider IN ('meta', 'gowa', 'waha'))`  
**Tidak ada Baileys** — dihapus di migration 006.

---

## Environment Variables

Semua ada di `.env.example`. Yang wajib:

```
META_VERIFY_TOKEN   — untuk verifikasi webhook Meta
META_APP_SECRET     — untuk HMAC signature Meta
DATABASE_URL        — PostgreSQL connection string
ADMIN_PASSWORD      — min 8 karakter
ADMIN_JWT_SECRET    — min 32 karakter
```

Provider-specific (opsional, hanya jika dipakai):
```
GOWA_URL / GOWA_WEBHOOK_SECRET / GOWA_BASIC_AUTH
WAHA_URL / WAHA_API_KEY / WAHA_WEBHOOK_SECRET
OPENROUTER_KEY / OPENROUTER_MODEL / OPENROUTER_FALLBACK_MODELS
TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_IDS
```

---

## Admin API

Semua endpoint `POST /api/admin/*`, butuh `Authorization: Bearer <JWT>`.

| Endpoint | Fungsi |
|----------|--------|
| `/login` | Login, dapat JWT |
| `/logout` | Revoke token |
| `/clients/list` | List semua client |
| `/clients/create` | Buat client baru |
| `/clients/update` | Update client |
| `/clients/delete` | Hapus client |
| `/clients/toggle` | Aktif/nonaktif client |
| `/templates/list` | List template per client |
| `/templates/create` | Buat template |
| `/templates/update` | Update template |
| `/templates/delete` | Hapus template |
| `/kb/list` | List KB per client |
| `/kb/create` | Buat KB |
| `/kb/update` | Update KB |
| `/kb/delete` | Hapus KB |
| `/history` | Chat history (paginated) |
| `/audit` | Audit log (paginated) |
| `/stats/summary` | Stats hari ini |
| `/stats/daily` | Stats per hari |
| `/stats/range` | Stats range tanggal |
| `/models/chain` | Lihat model chain aktif |
| `/models/benchmark` | Trigger benchmark manual |

---

## Telegram Admin Bot

Aktif jika `TELEGRAM_BOT_TOKEN` diset. Fitur:
- `/test <pesan>` — test AI dengan history percakapan
- `/testjson <pesan>` — test AI, tampilkan raw JSON
- `/clients` — list semua client
- `/client_add` — wizard tambah client baru
- `/client_toggle <id>` — aktif/nonaktif client
- `/client_del <id>` — hapus client
- `/templates <client_id>` — list template
- `/tpl_add <client_id>` — wizard tambah template
- `/tpl_del <id>` — hapus template
- `/kb <client_id>` — list KB
- `/kb_add <client_id>` — wizard tambah KB
- `/kb_del <id>` — hapus KB
- `/history <client_id>` — 10 chat terakhir
- `/stats` — stats hari ini
- `/audit` — 10 log audit terakhir
- `/chain` — model chain aktif + score
- `/benchmark` — jalankan benchmark
- `/status` — uptime + model info

---

## Webhook Endpoints

```
GET  /webhook              ← Meta hub.challenge verification
POST /webhook              ← Meta Cloud API inbound (HMAC-SHA256)
POST /webhook/gowa         ← GoWA inbound (HMAC-SHA256 opsional)
POST /webhook/waha         ← WaHA inbound (HMAC-SHA256 opsional)
GET  /health               ← DB health check
```

Semua POST webhook: balas 200 SEGERA, proses async di background.

---

## Security

- HMAC-SHA256 verification untuk semua webhook (timing-safe compare)
- JWT Bearer untuk semua admin API (blacklist dengan TTL 25h)
- Rate limit login: 5 attempt/menit per IP
- Rate limit pesan: 5 msg/menit per nomor HP
- SQL injection prevention: parameterized queries + ILIKE escape
- SSRF prevention: `urlGuard.isSafeUrl()` blokir private IP
- Input validation: semua admin endpoint validasi panjang + tipe
- Security headers: X-Content-Type-Options, X-Frame-Options, CSP, HSTS
- Body limit: 100KB untuk cegah DoS
- Statement timeout: 10s per query

---

## Cara Tambah Provider Baru

1. Buat `src/services/<provider>.js` dengan fungsi: `sendText`, `sendImage`, `sendFile`, `sendAudio`, `sendLocation`, `sendTyping`, `markRead`
2. Tambah routing di `src/services/sender.js` (if `client.provider === '<provider>'`)
3. Tambah webhook handler di `src/routes/webhook.js` (`router.post('/webhook/<provider>', ...)`)
4. Tambah kolom di `sql/schema.sql` dan migration SQL baru
5. Update `config.js` dengan env vars baru
6. Update `src/services/admin.js` fungsi `createClient` dan `updateClient`
7. Update `src/routes/admin.js` validasi input
8. Update constraint `clients_provider_check` di DB

---

## Cara Jalankan

```bash
# Install dependencies
npm install

# Setup DB (pertama kali)
npm run db:up          # start PostgreSQL via Docker
npm run db:init        # jalankan schema.sql
npm run db:migrate     # jalankan semua migration (001–006)
npm run db:seed        # insert demo data (dev only)

# Jalankan server
npm start              # production
npm run dev            # development (nodemon)

# Test
npm test               # butuh DB aktif di DATABASE_URL

# PM2 (production)
pm2 start ecosystem.config.js
```

---

## Bug Fixes (2026-05-06)

- `webhook.js`: GoWA msgId sekarang pakai `device_id` (bukan `req.gowaClient` yang tidak pernah di-set)
- `telegram.js`: double import `modelSelector` dihapus — sekarang satu baris
- `gowa.js`: tambah `isSafeUrl` check untuk sendImage/sendAudio/sendFile (SSRF prevention, konsisten dengan WaHA)
- `webhook.js`: hapus unused `isSafeUrl` import
- `orchestrator.js`: ganti semua `var` ke `let`
- `index.js`: tambah daily cleanup untuk `chat_history` (>90 hari) dan `conversations` (>30 hari tidak aktif)

---

## Anti-Patterns (Jangan Lakukan)

- Jangan import `baileys` — sudah dihapus total
- Jangan query DB tanpa parameterized query (`$1`, `$2`, ...)
- Jangan embed user input langsung ke URL (SSRF)
- Jangan kirim response webhook setelah proses async (sudah `res.sendStatus(200)` di awal)
- Jangan tambah provider baru tanpa update constraint `clients_provider_check`
- Jangan jalankan `seed-demo.js` di production (`NODE_ENV=production` diblokir)
- Jangan hardcode secret — semua dari env vars

---

## File Penting untuk Dibaca Pertama

Urutan baca jika mau paham codebase cepat:

1. `src/config.js` — semua env vars
2. `sql/schema.sql` — struktur DB
3. `src/services/orchestrator.js` — pipeline utama
4. `src/services/sender.js` — provider abstraction
5. `src/routes/webhook.js` — semua inbound handler
6. `src/services/ai.js` — AI engine + system prompt Kira
