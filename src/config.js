require("dotenv").config();

// Paksa timezone Jakarta (WIB, UTC+7) di seluruh proses Node.js
// Harus diset sebelum modul lain di-load agar new Date() konsisten
process.env.TZ = "Asia/Jakarta";

// Variabel wajib — aplikasi tidak bisa jalan tanpa ini
const required = ["DATABASE_URL"];
for (const k of required) {
  if (!process.env[k]) throw new Error(`Missing env: ${k}`);
}

// Validasi keamanan kredensial admin — wajib diisi dan cukup panjang
// Skip di mode test agar test runner tidak butuh env variabel ini
if (process.env.NODE_ENV !== "test") {
  const adminPwd    = process.env.ADMIN_PASSWORD    || "";
  const adminSecret = process.env.ADMIN_JWT_SECRET  || "";
  // ADMIN_PASSWORD wajib ada dan minimal 8 karakter — cegah brute force
  if (!adminPwd || adminPwd.length < 8) {
    throw new Error("ADMIN_PASSWORD wajib diisi dan minimal 8 karakter (set di .env)");
  }
  // ADMIN_JWT_SECRET wajib ada dan minimal 32 karakter — cegah brute force signature JWT
  if (!adminSecret || adminSecret.length < 32) {
    throw new Error("ADMIN_JWT_SECRET wajib diisi dan minimal 32 karakter (set di .env)");
  }
}

// Meta vars opsional — hanya dibutuhkan jika pakai provider 'meta'
if (!process.env.META_VERIFY_TOKEN || !process.env.META_APP_SECRET) {
  console.warn("WARNING: META_VERIFY_TOKEN / META_APP_SECRET not set — meta provider will not work");
}

module.exports = {
  port:    Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || "development",

  // Meta Cloud API
  metaVerifyToken: process.env.META_VERIFY_TOKEN,
  metaAppSecret:   process.env.META_APP_SECRET,
  metaApiVersion:  process.env.META_API_VERSION || "v19.0",

  // AI - OpenRouter
  openRouterKey:            process.env.OPENROUTER_KEY || "",
  openRouterModel:          process.env.OPENROUTER_MODEL || "inclusionai/ling-2.6-1t:free",
  openRouterFallbackModels: (process.env.OPENROUTER_FALLBACK_MODELS || "")
    .split(",").map(s => s.trim()).filter(Boolean),
  openRouterFreeRouter:     process.env.OPENROUTER_FREE_ROUTER || "openrouter/free",

  // Database
  databaseUrl: process.env.DATABASE_URL,
  dbSsl:       process.env.DB_SSL === "true",

  // Logging
  logLevel: process.env.LOG_LEVEL || "info",

  // Redis
  redisPrefix: process.env.REDIS_PREFIX || "ngomeai:",

  // Admin
  adminUsername:  process.env.ADMIN_USERNAME || "admin",
  adminPassword:  process.env.ADMIN_PASSWORD || "",
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || "",

  // Telegram Admin Bot
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramAdminIds: (process.env.TELEGRAM_ADMIN_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean).map(Number),

  // Evolution API
  evolutionUrl:       process.env.EVOLUTION_URL       || "",
  evolutionApiKey:    process.env.EVOLUTION_API_KEY   || "",

  // Baileys (multi-session, in-process WhatsApp)
  baileysSessionsDir: process.env.BAILEYS_SESSIONS_DIR || "./baileys_sessions",
};
