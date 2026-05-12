const express    = require("express");
const path       = require("path");
const { pool }   = require("./db");
const requestId  = require("./middleware/requestId");
const logger     = require("./utils/logger");
const webhookRouter = require("./api/webhook");
const adminRouter   = require("./api/admin");

const app = express();

// ─── Security headers (helmet-style, no external dep) ─────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options",  "nosniff");
  res.setHeader("X-Frame-Options",         "DENY");
  res.setHeader("X-XSS-Protection",        "1; mode=block");
  res.setHeader("Referrer-Policy",         "no-referrer");
  res.setHeader("Permissions-Policy",      "geolocation=(), camera=(), microphone=()");
  // HSTS: only emit on verified HTTPS connections
  if (req.secure || req.get("x-forwarded-proto") === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  // Admin pages use inline scripts — allow 'unsafe-inline' only for /admin/* paths.
  // API and webhook endpoints keep the strict policy.
  const isAdmin = req.path.startsWith("/admin");
  res.setHeader(
    "Content-Security-Policy",
    isAdmin
      ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'"
      : "default-src 'self'; script-src 'self' https://cdn.tailwindcss.com https://fonts.googleapis.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'"
  );
  next();
});

app.disable("x-powered-by");

// ─── CORS — only allow same-origin + Meta webhook IPs ─────────────────────
// Admin panel is served from the same origin, so no CORS needed for it.
// Webhook endpoint is called by Meta servers — no browser CORS required.
app.use((req, res, next) => {
  const origin = req.get("origin");
  const host   = req.get("host");
  // Block cross-origin requests to API endpoints.
  // Same-origin: browser sends Origin header that matches our host — allow it.
  if (origin && req.path.startsWith("/api/")) {
    const originHost = origin.replace(/^https?:\/\//, "");
    if (originHost !== host) {
      return res.status(403).json({ error: "Cross-origin requests not allowed" });
    }
  }
  next();
});

// ─── Request timeout — 30 s hard limit ────────────────────────────────────
app.use((req, res, next) => {
  res.setTimeout(30_000, () => {
    logger.warn("Request timeout", { path: req.path, method: req.method });
    if (!res.headersSent) res.status(503).json({ error: "Request timeout" });
  });
  next();
});

// Admin HTML pages are public shells — no sensitive data, no guard needed here.
// All actual data is protected by JWT Bearer check on every /api/admin/* endpoint.
// A 401 from any API call auto-triggers client-side logout + redirect to login.

// ─── Static files ──────────────────────────────────────────────────────────
// HTML pages: no-cache so browsers always fetch fresh JS after updates
app.use("/admin", (req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/" || req.path === "") {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});
app.use(express.static(path.join(__dirname, "../public")));

app.use(requestId);

// ─── Body parser — 100 KB hard limit ──────────────────────────────────────
// Prevents DoS via oversized JSON payloads.
// Webhook rawBody capture is preserved for HMAC verification.
app.use(
  express.json({
    limit: "100kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// ─── Health check ──────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", time: new Date().toISOString(), db: "ok" });
  } catch (err) {
    logger.error("Health check DB error", { error: err.message });
    res.status(503).json({ status: "degraded", db: "error" });
  }
});

app.use("/webhook",    webhookRouter);
app.use("/api/admin",  adminRouter);

// ─── Global error handler ──────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  logger.error("Unhandled error", { error: err.message, rid: req.requestId });
  res.status(500).json({ error: "Internal server error" });
});

module.exports = { app };
