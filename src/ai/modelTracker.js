/**
 * Model Performance Tracker
 *
 * Tracks real-time performance metrics per model:
 *   - Latency (40% weight)
 *   - Success rate (30% weight)
 *   - Cost (20% weight)
 *   - Feature match (10% weight)
 *
 * Uses sliding window (last 50 requests per model).
 * Refreshes scored chain every 60 seconds.
 */

const logger = require("../utils/logger");

const WINDOW_SIZE       = 50;    // last N requests per model
const RECORE_TTL_MS   = 60_000; // re-score every 60s
const WEIGHTS = { latency: 0.4, success: 0.3, cost: 0.2, feature: 0.1 };

// Per-model sliding window: Map<modelId, Array<{ ts, latency, success, tokens }>
const _windows = new Map();

// Scored chain cache
let _scoredChain  = null;
let _scoredAt     = 0;

// Base costs per model (USD per 1M tokens) — fallback estimates
const ESTIMATED_COST = {
  "z-ai/glm-4.5-air:free":    0,
  "nvidia/nemotron-3-super-120b-a12b:free": 0,
  "openai/gpt-oss-120b:free":              0,
  "poolside/laguna-m.1:free":                0,
  "openai/gpt-oss-20b:free":                0,
  "nvidia/nemotron-3-nano-30b-a3b:free": 0,
  "google/gemma-4-31b-it:free":              0,
  "nousresearch/hermes-3-llama-3.1-405b:free": 0,
  "inclusionai/ling-2.6-1t:free":           0,
  "openrouter/free":                          0,
};

// Feature capabilities per model (simplified)
const MODEL_FEATURES = {
  "z-ai/glm-4.5-air:free":    { vision: true, tools: true, reasoning: true },
  "openrouter/free":                { vision: false, tools: false, reasoning: false },
};

// ── Recording ──────────────────────────────────────────────────────────────

function recordSuccess(model, latencyMs, tokenCount = 0) {
  if (!model) return;
  let w = _windows.get(model);
  if (!w) { w = []; _windows.set(model, w); }
  w.push({ ts: Date.now(), latency: latencyMs, success: true, tokens: tokenCount });
  if (w.length > WINDOW_SIZE) w.shift(); // sliding window
}

function recordFailure(model) {
  if (!model) return;
  let w = _windows.get(model);
  if (!w) { w = []; _windows.set(model, w); }
  w.push({ ts: Date.now(), latency: 30_000, success: false, tokens: 0 });
  if (w.length > WINDOW_SIZE) w.shift();
}

// ── Scoring ──────────────────────────────────────────────────────────────

function getScoredChain(baseChain) {
  const now = Date.now();
  if (_scoredChain && (now - _scoredAt) < RECORE_TTL_MS) return _scoredChain;

  const scored = baseChain.map(model => {
    const w    = _windows.get(model) || [];
    const recent = w.filter(e => (now - e.ts) < 10 * 60_000); // last 10 min
    if (!recent.length) return { model, score: 0.5, latency: 5000, successRate: 1.0, cost: ESTIMATED_COST[model] || 1 };

    const avgLatency    = recent.reduce((sum, e) => sum + e.latency, 0) / recent.length;
    const successCount  = recent.filter(e => e.success).length;
    const successRate   = successCount / recent.length;

    // Normalize latency: 0ms → 1.0, 30s+ → 0.0
    const latencyScore  = Math.max(0, 1 - (avgLatency / 30_000));
    // Cost score: $0 → 1.0, $5+ → 0.0
    const cost         = ESTIMATED_COST[model] || 1;
    const costScore     = Math.max(0, 1 - (cost / 5));

    const score =
      (latencyScore  * WEIGHTS.latency) +
      (successRate  * WEIGHTS.success) +
      (costScore    * WEIGHTS.cost) +
      (0.1          * WEIGHTS.feature); // feature match placeholder

    return {
      model,
      score:        Math.max(0.01, Math.min(1, score)),
      latency:      Math.round(avgLatency),
      successRate:  Math.round(successRate * 100) / 100,
      cost,
    };
  });

  // Sort by score descending (best first)
  scored.sort((a, b) => b.score - a.score);

  const result = scored.map(s => s.model);
  // Ensure free router is always last
  const freeIdx = result.indexOf("openrouter/free");
  if (freeIdx > -1 && freeIdx < result.length - 1) {
    result.splice(freeIdx, 1);
    result.push("openrouter/free");
  }

  _scoredChain = result;
  _scoredAt   = now;

  logger.info("modelTracker: rescored chain", {
    chain: result.slice(0, 5),
    scores: scored.slice(0, 3).map(s => `${s.model}:${s.score.toFixed(2)}`),
  });

  return result;
}

function getModelStats() {
  const now = Date.now();
  const stats = [];
  for (const [model, w] of _windows) {
    const recent = w.filter(e => (now - e.ts) < 10 * 60_000);
    if (!recent.length) continue;
    const avgLatency   = recent.reduce((s, e) => s + e.latency, 0) / recent.length;
    const successRate  = recent.filter(e => e.success).length / recent.length;
    stats.push({
      id:           model,
      avgLatencyMs: Math.round(avgLatency),
      successRate:  Math.round(successRate * 100),
      sampleCount:  recent.length,
    });
  }
  stats.sort((a, b) => b.successRate - a.successRate || a.avgLatencyMs - b.avgLatencyMs);
  return stats;
}

function invalidateCache() {
  _scoredChain = null;
  _scoredAt   = 0;
}

module.exports = { recordSuccess, recordFailure, getScoredChain, getModelStats, invalidateCache };
