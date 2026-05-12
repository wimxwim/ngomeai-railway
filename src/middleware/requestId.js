const { randomUUID } = require("crypto");

// Allowlist: only alphanumeric, hyphens, underscores — max 64 chars.
// Prevents log injection via crafted x-request-id values (e.g. newlines, JSON fragments).
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

module.exports = function requestId(req, _res, next) {
  const incoming = req.get("x-request-id");
  req.requestId = (incoming && SAFE_ID_RE.test(incoming))
    ? incoming
    : randomUUID();
  next();
};
