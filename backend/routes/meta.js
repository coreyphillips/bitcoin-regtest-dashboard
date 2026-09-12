// Discovery and connection endpoints.
//
// publicRouter is mounted BEFORE the auth middleware so an agent can always
// find out what this API is and whether it needs a token. Everything else,
// including /api/connection which carries the node's RPC cookie, sits behind
// auth.

const express = require('express');

const cfg = require('../lib/config');
const { bitcoinRPC, getRpcCredentials, checkElectrsTCP } = require('../lib/rpc');
const { authInfo } = require('../lib/auth');
const { buildSpec, buildIndex, buildLlmsTxt } = require('../lib/openapi');
const { asyncHandler } = require('../lib/http');

const publicRouter = express.Router();
const privateRouter = express.Router();

// How the caller is reaching us, so emitted curl lines work verbatim from
// wherever they are run. Same approach the Electrs info endpoint already uses.
function externalBase(req) {
  const host = req.headers.host || `localhost:${cfg.PORT}`;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${host}`;
}

function externalHost(req) {
  return req.hostname || (req.headers.host || '').split(':')[0] || 'localhost';
}

publicRouter.get('/', asyncHandler(async (req, res) => {
  let chain = 'unknown';
  try {
    chain = (await bitcoinRPC('getblockchaininfo', [], false, { quiet: true })).chain;
  } catch (e) {
    /* the index must answer even when the node is down */
  }
  res.json(buildIndex({ baseUrl: externalBase(req), auth: authInfo(), chain }));
}));

publicRouter.get('/openapi.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(buildSpec({ baseUrl: externalBase(req), authRequired: !!cfg.API_TOKEN }));
});

publicRouter.get('/llms.txt', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(buildLlmsTxt({ baseUrl: externalBase(req), authRequired: !!cfg.API_TOKEN }));
});

// Unauthenticated on purpose: this is the liveness probe, and an agent needs to
// be able to discover that a token is required before it has one.
publicRouter.get('/health', async (req, res) => {
  try {
    const info = await bitcoinRPC('getblockchaininfo', [], false, { quiet: true });
    res.json({ status: 'ok', chain: info.chain, blocks: info.blocks, auth: authInfo() });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message, auth: authInfo() });
  }
});

privateRouter.get('/connection', asyncHandler(async (req, res) => {
  const host = externalHost(req);
  const base = externalBase(req);

  let chain = 'unknown';
  try {
    chain = (await bitcoinRPC('getblockchaininfo', [], false, { quiet: true })).chain;
  } catch (e) {
    /* still report what we can */
  }

  const credentials = getRpcCredentials();
  // Withhold the RPC password off regtest. CORS is wide open by default, so on
  // a real node any page the user visits could otherwise read live credentials.
  const shareCredentials = chain === 'regtest' && cfg.EXPOSE_RPC_CREDENTIALS;

  const auth = shareCredentials
    ? { method: credentials.source, cookieFile: credentials.cookieFile, username: credentials.username, password: credentials.password }
    : {
        method: credentials.source,
        cookieFile: credentials.cookieFile,
        username: null,
        password: null,
        credentialsWithheld: chain === 'regtest' ? 'EXPOSE_RPC_CREDENTIALS is disabled' : `non-regtest chain (${chain})`
      };

  res.json({
    network: chain,
    dashboard: {
      baseUrl: base,
      apiBase: `${base}/api`,
      openapi: `${base}/api/openapi.json`,
      llmsTxt: `${base}/api/llms.txt`,
      auth: authInfo()
    },
    bitcoinRpc: {
      host: cfg.RPC_HOST,
      port: parseInt(cfg.RPC_PORT, 10),
      url: `http://${cfg.RPC_HOST}:${cfg.RPC_PORT}/`,
      walletUrl: `http://${cfg.RPC_HOST}:${cfg.RPC_PORT}/wallet/${cfg.RPC_WALLET}`,
      wallet: cfg.RPC_WALLET,
      // The bundled compose file exposes 18443 on the Docker network only, to
      // avoid clashing with any other Bitcoin node on the host.
      reachableFromHost: false,
      note: `Port ${cfg.RPC_PORT} is published on the Docker network only, not to the host. From outside, use POST ${base}/api/rpc, or docker compose exec bitcoin bitcoin-cli -regtest.`,
      auth
    },
    p2p: { host: cfg.RPC_HOST, port: parseInt(cfg.P2P_PORT, 10), publishedToHost: false },
    electrum: {
      host,
      port: parseInt(cfg.ELECTRS_EXTERNAL_PORT, 10),
      protocol: 'tcp',
      connectionString: `${host}:${cfg.ELECTRS_EXTERNAL_PORT}:t`,
      command: `electrum --regtest --oneserver --server ${host}:${cfg.ELECTRS_EXTERNAL_PORT}:t`,
      reachable: await checkElectrsTCP()
    },
    zmq: {
      rawblock: cfg.ZMQ_RAWBLOCK || `tcp://${cfg.RPC_HOST}:28332`,
      rawtx: cfg.ZMQ_RAWTX || `tcp://${cfg.RPC_HOST}:28333`,
      publishedToHost: false
    },
    recipes: {
      status: `curl -s ${base}/api/status`,
      fund: `curl -sX POST ${base}/api/faucet -H 'Content-Type: application/json' -d '{"address":"bcrt1...","amount":1}'`,
      mine: `curl -sX POST ${base}/api/mine -H 'Content-Type: application/json' -d '{"blocks":1}'`,
      waitBlock: `curl -s "${base}/api/wait/height/<height>?timeout=30"`,
      reorg: `curl -sX POST ${base}/api/chain/reorg -H 'Content-Type: application/json' -d '{"depth":2,"includeMempool":false}'`,
      logs: `curl -s "${base}/api/logs/bitcoind?lines=50"`,
      anyRpc: `curl -sX POST ${base}/api/rpc -H 'Content-Type: application/json' -d '{"method":"getblockchaininfo","params":[]}'`
    }
  });
}));

module.exports = { publicRouter, privateRouter };
