// Immutable, environment-derived configuration.
//
// Note: the Bitcoin RPC username/password are deliberately NOT exported here.
// They are re-read from the cookie file every 30 seconds, and a destructured
// `const { RPC_USER } = require('./config')` would capture the value at require
// time and go stale after the first cookie rotation. They live module-private
// inside lib/rpc.js instead, where the only reader is bitcoinRPC itself.

const path = require('path');

const COOKIE_FILE = process.env.BITCOIN_COOKIE_FILE || '';

// bitcoind writes debug.log next to the cookie file, so derive it from there.
// That is correct for the bundled compose file and for any external node whose
// cookie path is configured, with an explicit override for everything else.
const BITCOIN_DEBUG_LOG =
  process.env.BITCOIN_DEBUG_LOG ||
  (COOKIE_FILE ? path.join(path.dirname(COOKIE_FILE), 'debug.log') : '/bitcoin/.bitcoin/regtest/debug.log');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

module.exports = {
  PORT: intEnv('PORT', 3000),

  RPC_HOST: process.env.BITCOIN_RPC_HOST || 'bitcoin',
  RPC_PORT: process.env.BITCOIN_RPC_PORT || '18443',
  RPC_WALLET: process.env.BITCOIN_RPC_WALLET || 'regtest_wallet',
  COOKIE_FILE,
  P2P_PORT: process.env.BITCOIN_P2P_PORT || '18444',
  ZMQ_RAWBLOCK: process.env.BITCOIN_ZMQ_RAWBLOCK || '',
  ZMQ_RAWTX: process.env.BITCOIN_ZMQ_RAWTX || '',

  ELECTRS_HOST: process.env.ELECTRS_HOST || 'electrs',
  ELECTRS_PORT: process.env.ELECTRS_PORT || '50001',
  ELECTRS_EXTERNAL_PORT: process.env.ELECTRS_EXTERNAL_PORT || '60401',

  // Optional bearer token. Unset means the API is wide open, exactly as before.
  API_TOKEN: process.env.API_TOKEN || '',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  // Withhold the bitcoind cookie from GET /api/connection even on regtest.
  EXPOSE_RPC_CREDENTIALS: boolEnv('EXPOSE_RPC_CREDENTIALS', true),

  BITCOIN_DEBUG_LOG,
  LOG_RPC: boolEnv('LOG_RPC', true),
  LOG_BUFFER_SIZE: intEnv('LOG_BUFFER_SIZE', 2000),
  MAX_LOG_STREAMS: intEnv('MAX_LOG_STREAMS', 8),

  RPC_TIMEOUT_MS: intEnv('RPC_TIMEOUT_MS', 0), // 0 = no timeout, i.e. previous behavior
  FAUCET_MAX_BOOTSTRAP_BLOCKS: intEnv('FAUCET_MAX_BOOTSTRAP_BLOCKS', 600),
  REORG_MAX_DEPTH: intEnv('REORG_MAX_DEPTH', 100),
  WAIT_MAX_TIMEOUT_SECONDS: intEnv('WAIT_MAX_TIMEOUT_SECONDS', 120)
};
