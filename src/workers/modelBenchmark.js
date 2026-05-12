const axios  = require("axios");
const fs     = require("fs");
const path   = require("path");
const config = require("../config");
const logger = require("../utils/logger");

const CHAIN_FILE      = path.join(__dirname, "../../data/model_chain.json");
const CHAIN_SIZE      = 4;
const TEST_TIMEOUT_MS = 18000;
const BATCH_SIZE      = 4;
const BATCH_DELAY_MS  = 2500;

let _running = false; // module-level guard — prevents concurrent benchmark runs

// Standard test: must return valid JSON with our required schema
const TEST_MESSAGES = [
  {
    role: "system",
    content:
      "Jawab dengan JSON valid saja, tanpa teks lain. " +
      'Schema wajib: {"intent":string,"confidence":number,"response":string,"actions":[],"next_state":string}',
  },
  { role: "user", content: "Halo, saya mau tanya harga produk dan cara pemesanan" },
];

// Patterns in model ID that indicate non-chat capabilities
const SKIP_PATTERNS = ["embed", ":ocr", "-ocr", "whisper", "tts", "speech", "-vl", ":vl"];

function shouldSkip(id) {
  const lower = id.toLowerCase();
  return SKIP_PATTERNS.some(p => lower.includes(p));
}

function extractJsonObject(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (s.startsWith("{") && s.endsWith("}")) return s;
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function scoreResult({ latencyMs, content, reasoning }) {
  let score = 0;
  const raw = content || reasoning || "";

  // Direct content is ideal; reasoning-only models (content=null) are demoted
  if (content)          score += 40;
  else if (reasoning)   score += 15;

  // Valid JSON with all required fields
  const jsonStr = extractJsonObject(raw);
  if (jsonStr) {
    try {
      const obj = JSON.parse(jsonStr);
      if (
        typeof obj.intent === "string" &&
        typeof obj.confidence === "number" &&
        typeof obj.response === "string" &&
        obj.response.trim()
      ) {
        score += 30;
      }
    } catch (_) {}
  }

  // Latency bonuses
  if      (latencyMs < 3000)  score += 20;
  else if (latencyMs < 6000)  score += 12;
  else if (latencyMs < 10000) score +=  5;

  return score;
}

async function testModel(model) {
  const t0 = Date.now();
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model: model.id, messages: TEST_MESSAGES, max_tokens: 400 },
      {
        headers: {
          Authorization:  `Bearer ${config.openRouterKey}`,
          "Content-Type": "application/json",
        },
        timeout: TEST_TIMEOUT_MS,
      }
    );
    const latencyMs = Date.now() - t0;
    const msg       = res.data?.choices?.[0]?.message || {};
    const content   = msg.content   || null;
    const reasoning = msg.reasoning || null;
    const score     = scoreResult({ latencyMs, content, reasoning });
    logger.debug("modelBenchmark testModel", { id: model.id, score, latencyMs, content: !!content });
    return { id: model.id, score, latencyMs, hasContent: !!content, ok: score > 0 };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const status    = err?.response?.status;
    // 429 = rate-limited — model is valid but busy; give small score so it can enter fallback slot
    const score = status === 429 ? 8 : 0;
    logger.debug("modelBenchmark testModel error", { id: model.id, status, latencyMs });
    return { id: model.id, score, latencyMs, hasContent: false, ok: false, status };
  }
}

async function fetchFreeModels() {
  const res = await axios.get("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${config.openRouterKey}` },
    timeout: 15000,
  });
  return res.data.data.filter(
    m =>
      Number(m.pricing?.prompt) === 0 &&
      (m.context_length || 0) >= 32768 &&
      !shouldSkip(m.id)
  );
}

async function runBenchmark() {
  if (!config.openRouterKey) {
    logger.warn("modelBenchmark: no API key configured, skipping");
    return null;
  }
  if (_running) {
    logger.warn("modelBenchmark: already running, skipping concurrent call");
    return null;
  }
  _running = true;
  try {
    return await _runBenchmarkInner();
  } finally {
    _running = false;
  }
}

async function _runBenchmarkInner() {
  const startedAt = Date.now();

  let models;
  try {
    models = await fetchFreeModels();
  } catch (err) {
    logger.error("modelBenchmark: failed to fetch model list", { error: err.message });
    return null;
  }

  logger.info(`modelBenchmark: ${models.length} free models to test`);

  const results = [];
  for (let i = 0; i < models.length; i += BATCH_SIZE) {
    const batch = models.slice(i, i + BATCH_SIZE);
    const out   = await Promise.all(batch.map(testModel));
    results.push(...out);
    const done = Math.min(i + BATCH_SIZE, models.length);
    logger.info(`modelBenchmark: progress ${done}/${models.length}`);
    if (i + BATCH_SIZE < models.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  results.sort((a, b) => b.score - a.score || a.latencyMs - b.latencyMs);

  const chain = results
    .filter(r => r.score > 0)
    .slice(0, CHAIN_SIZE)
    .map(r => r.id);

  if (chain.length === 0) {
    logger.warn("modelBenchmark: no models passed minimum score, keeping existing chain");
    return null;
  }

  const payload = {
    updatedAt:  new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    chain,
    topResults: results.slice(0, 10),
    totalTested: results.length,
  };

  const dataDir = path.dirname(CHAIN_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  // Atomic write: write to temp then rename to avoid partial reads on crash
  const tmpFile = CHAIN_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpFile, CHAIN_FILE);

  logger.info("modelBenchmark: completed", {
    chain,
    topModel:  results[0]?.id,
    topScore:  results[0]?.score,
    durationMs: payload.durationMs,
  });

  return payload;
}

function readLastResult() {
  try {
    if (fs.existsSync(CHAIN_FILE)) {
      return JSON.parse(fs.readFileSync(CHAIN_FILE, "utf8"));
    }
  } catch (_) {}
  return null;
}

module.exports = { runBenchmark, readLastResult, CHAIN_FILE };
