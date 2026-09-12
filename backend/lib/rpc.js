// Bitcoin Core JSON-RPC and Electrum protocol clients.

const http = require('http');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');

const cfg = require('./config');
const logbuffer = require('./logbuffer');

// RPC credentials. Module-private on purpose: readCookieFile() reassigns these
// every 30 seconds and any module that destructured them would go stale.
let RPC_USER = process.env.BITCOIN_RPC_USER || '';
let RPC_PASS = process.env.BITCOIN_RPC_PASS || '';
let credentialSource = RPC_USER ? 'env' : 'default';

function readCookieFile() {
  if (cfg.COOKIE_FILE && fs.existsSync(cfg.COOKIE_FILE)) {
    try {
      const cookie = fs.readFileSync(cfg.COOKIE_FILE, 'utf8').trim();
      const idx = cookie.indexOf(':');
      const user = idx === -1 ? '' : cookie.slice(0, idx);
      const pass = idx === -1 ? '' : cookie.slice(idx + 1);
      if (user && pass) {
        const changed = user !== RPC_USER || pass !== RPC_PASS;
        RPC_USER = user;
        RPC_PASS = pass;
        credentialSource = 'cookie';
        if (changed) console.log(`Read RPC credentials from cookie file: ${cfg.COOKIE_FILE}`);
        return true;
      }
    } catch (e) {
      console.error(`Failed to read cookie file: ${e.message}`);
    }
  }
  return false;
}

function startCookieRefresh() {
  if (!cfg.COOKIE_FILE) return;
  readCookieFile();
  // The cookie is regenerated whenever bitcoind restarts.
  const timer = setInterval(readCookieFile, 30000);
  if (timer.unref) timer.unref();
}

if (cfg.COOKIE_FILE) startCookieRefresh();
if (!RPC_USER) RPC_USER = 'regtest';
if (!RPC_PASS) RPC_PASS = 'regtest';

function getRpcCredentials() {
  return {
    username: RPC_USER,
    password: RPC_PASS,
    source: credentialSource,
    cookieFile: cfg.COOKIE_FILE || null
  };
}

/**
 * Call a Bitcoin Core JSON-RPC method.
 *
 * @param {string} method
 * @param {Array} params
 * @param {boolean} useWallet  route to /wallet/<name> instead of /
 * @param {{quiet?: boolean, timeoutMs?: number, wallet?: string}} opts
 *
 * `opts` is a 4th positional parameter so every existing call site keeps
 * working unchanged. Rejections carry `.rpcCode` (the JSON-RPC error code) in
 * addition to the message, which the previous implementation discarded.
 */
async function bitcoinRPC(method, params = [], useWallet = false, opts = {}) {
  const started = Date.now();
  const quiet = opts.quiet === true;
  const walletName = opts.wallet || cfg.RPC_WALLET;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      jsonrpc: '1.0',
      id: Date.now(),
      method: method,
      params: params
    });

    const path = useWallet ? `/wallet/${walletName}` : '/';

    if (cfg.LOG_RPC && !quiet) {
      console.log(`RPC Call: ${method} useWallet=${useWallet} path=${path} host=${cfg.RPC_HOST}:${cfg.RPC_PORT}`);
    }

    const options = {
      hostname: cfg.RPC_HOST,
      port: cfg.RPC_PORT,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64')
      }
    };

    const finish = (err, result) => {
      logbuffer.recordRpc({
        method,
        params: summarizeParams(params),
        useWallet,
        durationMs: Date.now() - started,
        ok: !err,
        error: err ? err.message : undefined,
        rpcCode: err && err.rpcCode !== undefined ? err.rpcCode : undefined
      });
      if (err) reject(err); else resolve(result);
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (cfg.LOG_RPC && !quiet) {
          console.log(`RPC Response for ${method}: ${data.substring(0, 200)}`);
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            const err = new Error(parsed.error.message || 'RPC Error');
            err.name = 'BitcoinRpcError';
            err.rpcCode = parsed.error.code;
            finish(err);
          } else {
            finish(null, parsed.result);
          }
        } catch (e) {
          const err = new Error('Failed to parse RPC response');
          err.name = 'BitcoinRpcError';
          err.httpStatus = res.statusCode;
          finish(err);
        }
      });
    });

    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : cfg.RPC_TIMEOUT_MS;
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`RPC timeout after ${timeoutMs}ms calling ${method}`));
      });
    }

    req.on('error', (e) => finish(e));
    req.write(postData);
    req.end();
  });
}

// Keep the RPC log readable: long hex blobs and big arrays are summarized.
function summarizeParams(params) {
  try {
    return (Array.isArray(params) ? params : [params]).map((p) => {
      if (typeof p === 'string') return p.length > 80 ? `${p.slice(0, 64)}...(${p.length} chars)` : p;
      if (Array.isArray(p)) return `[${p.length} items]`;
      return p;
    });
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Electrum protocol (Electrs speaks newline-delimited JSON-RPC over raw TCP)
// ---------------------------------------------------------------------------

async function checkElectrsTCP() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.connect(parseInt(cfg.ELECTRS_PORT), cfg.ELECTRS_HOST);
  });
}

async function electrsRPC(method, params = []) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let data = '';
    socket.setTimeout(5000);

    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: method,
      params: params
    }) + '\n';

    socket.on('connect', () => socket.write(request));

    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        socket.destroy();
        try {
          const response = JSON.parse(data.trim());
          if (response.error) {
            reject(new Error(response.error.message || 'Electrs RPC error'));
          } else {
            resolve(response.result);
          }
        } catch (e) {
          reject(new Error('Failed to parse Electrs response'));
        }
      }
    });

    socket.on('timeout', () => { socket.destroy(); reject(new Error('Electrs connection timeout')); });
    socket.on('error', (e) => { socket.destroy(); reject(new Error('Electrs connection error: ' + e.message)); });

    socket.connect(parseInt(cfg.ELECTRS_PORT), cfg.ELECTRS_HOST);
  });
}

// Electrum addresses scripts by the reversed SHA256 of the scriptPubKey.
async function getScripthashFromAddress(address) {
  try {
    const validation = await bitcoinRPC('validateaddress', [address]);
    if (!validation.isvalid) throw new Error('Invalid address');
    const hash = crypto.createHash('sha256').update(Buffer.from(validation.scriptPubKey, 'hex')).digest();
    return Buffer.from(hash).reverse().toString('hex');
  } catch (error) {
    throw new Error('Failed to convert address to scripthash: ' + error.message);
  }
}

module.exports = {
  bitcoinRPC,
  getRpcCredentials,
  readCookieFile,
  checkElectrsTCP,
  electrsRPC,
  getScripthashFromAddress
};
