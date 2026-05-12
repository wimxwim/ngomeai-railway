const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || "info"] ?? 1;

function log(level, msg, meta = {}) {
  if (LEVELS[level] < currentLevel) return;
  const fn = level === "error" ? console.error : console.log;
  fn(JSON.stringify({ time: new Date().toISOString(), level, msg, ...meta }));
}

module.exports = {
  debug: (msg, meta) => log("debug", msg, meta),
  info:  (msg, meta) => log("info",  msg, meta),
  warn:  (msg, meta) => log("warn",  msg, meta),
  error: (msg, meta) => log("error", msg, meta)
};
