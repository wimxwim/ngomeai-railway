const jwt    = require("jsonwebtoken");
const config = require("../config");
// Redis untuk token blacklist — persistent lintas restart, konsisten di multi-process
const redis  = require("../utils/redis");

// TTL token blacklist: 25 jam (JWT TTL 24 jam + 1 jam buffer keamanan)
const TOKEN_TTL_SECS = 25 * 60 * 60;
// Panjang maksimal token JWT yang diterima — tolak token abnormal besar
const MAX_TOKEN_BYTES = 2048;

/**
 * Tambahkan token ke blacklist Redis.
 * Dipanggil saat logout agar token yang masih valid tidak bisa dipakai lagi.
 * @param {string} token - JWT string dari header Authorization
 */
async function blacklistToken(token) {
  if (!token || typeof token !== "string") return;
  // Tolak token yang terlalu besar — kemungkinan serangan header injection
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) return;
  // Simpan ke Redis dengan TTL 25 jam — otomatis expire, tidak perlu sweep manual
  await redis.setKey(`auth:blacklist:${token}`, "1", TOKEN_TTL_SECS);
}

/**
 * Middleware Express: validasi JWT dari header Authorization.
 * Tolak token yang sudah di-blacklist atau tidak valid.
 */
async function adminAuth(req, res, next) {
  const auth = req.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const token = auth.slice(7);

  // Tolak token yang terlalu besar sebelum proses apapun
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    return res.status(401).json({ success: false, error: "Invalid token" });
  }

  // Cek blacklist di Redis — token yang sudah logout tidak bisa dipakai lagi
  const revoked = await redis.getKey(`auth:blacklist:${token}`).catch(() => null);
  if (revoked) {
    return res.status(401).json({ success: false, error: "Token revoked" });
  }

  try {
    // Verifikasi signature dan expiry JWT
    req.admin      = jwt.verify(token, config.adminJwtSecret);
    req.adminToken = token;
    next();
  } catch {
    res.status(401).json({ success: false, error: "Invalid token" });
  }
}

module.exports = { adminAuth, blacklistToken };
