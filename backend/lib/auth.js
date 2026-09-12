// Optional bearer-token auth.
//
// When API_TOKEN is unset the API is wide open, exactly as it was before this
// existed, so no deployment breaks by upgrading.

const crypto = require('crypto');
const cfg = require('./config');

// Hash both sides before comparing: timingSafeEqual throws on a length
// mismatch, and a raw length check would leak the token length.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (/^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  if (req.headers['x-api-token']) return String(req.headers['x-api-token']).trim();
  // EventSource cannot set request headers, so SSE needs a query fallback.
  if (req.query && req.query.access_token) return String(req.query.access_token);
  return null;
}

function requireToken(req, res, next) {
  if (!cfg.API_TOKEN) return next();
  if (req.method === 'OPTIONS') return next(); // let cors() answer the preflight

  const token = extractToken(req);
  if (token && safeEqual(token, cfg.API_TOKEN)) return next();

  res.set('WWW-Authenticate', 'Bearer realm="bitcoin-regtest-dashboard"');
  res.status(401).json({
    error: 'API token required',
    hint: 'Send Authorization: Bearer <token> using the API_TOKEN configured on the server. For SSE, use ?access_token=<token>.',
    docs: '/api'
  });
}

function authInfo() {
  return {
    required: !!cfg.API_TOKEN,
    scheme: 'bearer',
    header: 'Authorization: Bearer <token>',
    queryParam: 'access_token',
    envVar: 'API_TOKEN',
    openEndpoints: ['GET /api', 'GET /api/health', 'GET /api/openapi.json']
  };
}

module.exports = { requireToken, authInfo, safeEqual };
