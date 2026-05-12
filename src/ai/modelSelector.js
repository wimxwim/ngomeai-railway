const fs     = require("fs");
const config = require("../config");
const logger = require("../utils/logger");
const { CHAIN_FILE } = require("../workers/modelBenchmark");

const CACHE_TTL_MS = 60_000; // re-read file at most every 60s

let _chain      = null;
let _loadedAt    = 0;
let _modelConfig = null;

// Default temperature per model (can be overridden by model_chain.json)
const DEFAULT_CONFIG = {
  "tencent/hy3-preview:free":               { temperature: 0.7 },
  "nvidia/nemotron-3-super-120b-a12b:free": { temperature: 0.7 },
  "openai/gpt-oss-120b:free":               { temperature: 0.7 },
  "poolside/laguna-m.1:free":               { temperature: 0.7 },
  "openai/gpt-oss-20b:free":                { temperature: 0.7 },
  "nvidia/nemotron-3-nano-30b-a3b:free":   { temperature: 0.7 },
  "google/gemma-4-31b-it:free":             { temperature: 0.7 },
  "nousresearch/hermes-3-llama-3.1-405b:free": { temperature: 0.7 },
  "inclusionai/ling-2.6-1t:free":          { temperature: 0.7 },
  "openrouter/free":                         { temperature: 0.7 },
};

function getModelChain() {
  const now = Date.now();
  if (_chain && (now - _loadedAt) < CACHE_TTL_MS) return _chain;

  try {
    if (fs.existsSync(CHAIN_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHAIN_FILE, "utf8"));
      if (Array.isArray(data.chain) && data.chain.length > 0) {
        _chain    = data.chain;
        _loadedAt = now;
        // Load model config from same file if present
        if (data.config) {
          _modelConfig = { ...DEFAULT_CONFIG, ...data.config };
        }
        return _chain;
      }
    }
  } catch (err) {
    logger.warn("modelSelector: failed to read chain file", { error: err.message });
  }

  // Fallback: use env-configured models
  const fallback = [config.openRouterModel, ...config.openRouterFallbackModels].filter(Boolean);
  _chain    = fallback;
  _loadedAt = now;
  return fallback;
}

function getModelConfig() {
  if (_modelConfig) return _modelConfig;
  return DEFAULT_CONFIG;
}

function invalidateCache() {
  _chain       = null;
  _loadedAt    = 0;
  _modelConfig = null;
}

module.exports = { getModelChain, getModelConfig, invalidateCache };
