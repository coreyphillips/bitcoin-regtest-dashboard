// High level endpoints for driving a regtest network from a test suite or an
// agent. These wrap sequences that are tedious and easy to get wrong by hand.

const express = require('express');
const { setTimeout: sleep } = require('timers/promises');

const cfg = require('../lib/config');
const { bitcoinRPC, checkElectrsTCP } = require('../lib/rpc');
const { resolveMiningAddress, autoMineStatus, isAutoMineRunning } = require('../lib/mining');
const { ensureWalletLoaded } = require('../lib/wallet');
const { HttpError, asyncHandler } = require('../lib/http');

const router = express.Router();

const SATS = 100000000;
const STARTED_AT = Date.now();

async function assertRegtest(what) {
  const info = await bitcoinRPC('getblockchaininfo', [], false, { quiet: true });
  if (info.chain !== 'regtest') {
    throw new HttpError(403, `${what} is only available on regtest`, { details: { chain: info.chain } });
  }
  return info;
}

// ---------------------------------------------------------------------------
// Faucet
// ---------------------------------------------------------------------------

// Serialize bootstrap mining so two concurrent faucet calls do not each decide
// the wallet is empty and mine their own 101 blocks.
let bootstrapChain = Promise.resolve();
function withBootstrapLock(fn) {
  const run = bootstrapChain.then(fn, fn);
  bootstrapChain = run.then(() => undefined, () => undefined);
  return run;
}

async function currentSubsidyBtc() {
  try {
    const height = await bitcoinRPC('getblockcount', [], false, { quiet: true });
    const stats = await bitcoinRPC('getblockstats', [height, ['subsidy']], false, { quiet: true });
    const btc = (stats.subsidy || 0) / SATS;
    return btc > 0 ? btc : 50;
  } catch (e) {
    return 50; // pre-halving default; over-mining is harmless, the loop corrects
  }
}

// Regtest coinbase needs 100 confirmations to mature, so a fresh chain has a
// zero spendable balance no matter how many blocks were mined. Mining N blocks
// from height H matures exactly N - 100 coinbases.
async function ensureSpendable(amountBtc, maxBlocks) {
  const need = amountBtc + 0.001; // fee headroom
  let balances = await bitcoinRPC('getbalances', [], true, { quiet: true });
  if (balances.mine.trusted >= need) return { performed: false };

  const address = await resolveMiningAddress(null);
  const subsidy = await currentSubsidyBtc();
  let mined = 0;
  let rounds = 0;

  while (rounds++ < 4 && mined < maxBlocks) {
    const shortfall = need - balances.mine.trusted;
    const coinbasesNeeded = Math.max(1, Math.ceil(shortfall / subsidy));
    const batch = Math.min(maxBlocks - mined, 100 + coinbasesNeeded);

    await bitcoinRPC('generatetoaddress', [batch, address], false, { timeoutMs: 300000 });
    mined += batch;

    balances = await bitcoinRPC('getbalances', [], true, { quiet: true });
    if (balances.mine.trusted >= need) break;
  }

  if (balances.mine.trusted < need) {
    throw new HttpError(409, `Could not reach a spendable balance of ${need} BTC after mining ${mined} blocks`, {
      hint: 'Raise FAUCET_MAX_BOOTSTRAP_BLOCKS or request a smaller amount.',
      details: { balanceBtc: balances.mine.trusted, blocksMined: mined }
    });
  }

  return { performed: true, blocksMined: mined, reason: 'insufficient mature balance' };
}

// Bounded idempotency cache, so a client that times out and retries does not
// double fund. Opt in by sending an idempotencyKey.
const idempotency = new Map();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX = 100;

function idempotencyGet(key) {
  const hit = idempotency.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > IDEMPOTENCY_TTL_MS) {
    idempotency.delete(key);
    return null;
  }
  return hit.promise;
}

function idempotencySet(key, promise) {
  if (idempotency.size >= IDEMPOTENCY_MAX) {
    const oldest = idempotency.keys().next().value;
    idempotency.delete(oldest);
  }
  idempotency.set(key, { at: Date.now(), promise });
}

router.post('/faucet', asyncHandler(async (req, res) => {
  const key = req.body && req.body.idempotencyKey;
  if (key) {
    const existing = idempotencyGet(String(key));
    if (existing) return res.json(await existing);
  }

  const run = runFaucet(req.body || {});
  if (key) idempotencySet(String(key), run);
  res.json(await run);
}));

async function runFaucet(body) {
  const started = Date.now();
  await assertRegtest('The faucet');
  await ensureWalletLoaded();

  const amount = body.amount === undefined ? 1 : parseFloat(body.amount);
  const confirmations = body.confirmations === undefined ? 1 : parseInt(body.confirmations, 10);
  const feeRate = body.feeRate === undefined ? 1 : parseFloat(body.feeRate);
  const bootstrap = body.bootstrap !== false;

  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'amount must be a positive number of BTC');
  if (amount > 21000000) throw new HttpError(400, 'amount exceeds the total Bitcoin supply');
  if (!Number.isFinite(confirmations) || confirmations < 0 || confirmations > 100) {
    throw new HttpError(400, 'confirmations must be between 0 and 100');
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) throw new HttpError(400, 'feeRate must be a positive number of sat/vB');

  let address = body.address;
  if (address) {
    const validation = await bitcoinRPC('validateaddress', [address], false, { quiet: true });
    if (!validation.isvalid) {
      throw new HttpError(400, `Invalid address: ${address}`, {
        hint: 'Regtest addresses start with bcrt1, m, n or 2.'
      });
    }
  } else {
    address = await bitcoinRPC('getnewaddress', ['faucet', 'bech32'], true);
  }

  const bootstrapResult = bootstrap
    ? await withBootstrapLock(() => ensureSpendable(amount, cfg.FAUCET_MAX_BOOTSTRAP_BLOCKS))
    : { performed: false, skipped: true };

  // fee_rate rather than conf_target: regtest has no fee estimation data.
  const txid = await bitcoinRPC('sendtoaddress', [
    address, amount, 'faucet', '', false, true, null, 'unset', false, feeRate
  ], true, { timeoutMs: 60000 });

  let minedBlocks = [];
  if (confirmations > 0) {
    const miningAddress = await resolveMiningAddress(null);
    minedBlocks = await bitcoinRPC('generatetoaddress', [confirmations, miningAddress], false, { timeoutMs: 120000 });
  }

  const tx = await bitcoinRPC('gettransaction', [txid, true, true], true, { quiet: true });

  // A caller funding a wallet under test needs the exact outpoint.
  let vout = null;
  if (tx.decoded && Array.isArray(tx.decoded.vout)) {
    const match = tx.decoded.vout.find((o) => o.scriptPubKey && o.scriptPubKey.address === address);
    if (match) vout = match.n;
  }

  const height = await bitcoinRPC('getblockcount', [], false, { quiet: true });

  return {
    txid,
    address,
    vout,
    amountBtc: amount,
    amountSats: Math.round(amount * SATS),
    confirmations: tx.confirmations || 0,
    blockHash: tx.blockhash || null,
    blockHeight: tx.blockheight !== undefined ? tx.blockheight : null,
    feeBtc: tx.fee !== undefined ? tx.fee : null,
    height,
    minedBlocks,
    bootstrap: bootstrapResult,
    elapsedMs: Date.now() - started
  };
}

// ---------------------------------------------------------------------------
// Reorg
// ---------------------------------------------------------------------------

router.post('/chain/reorg', asyncHandler(async (req, res) => {
  await assertRegtest('Chain reorg');

  const body = req.body || {};
  const depth = parseInt(body.depth, 10);
  const extra = body.extra === undefined ? 1 : parseInt(body.extra, 10);
  const includeMempool = body.includeMempool !== false;
  const force = body.force === true;

  if (!Number.isFinite(depth) || depth < 1) throw new HttpError(400, 'depth must be at least 1');
  if (depth > cfg.REORG_MAX_DEPTH) {
    throw new HttpError(400, `depth must not exceed ${cfg.REORG_MAX_DEPTH}`, {
      hint: 'invalidateblock holds the node lock while it disconnects blocks, so deep reorgs stall every other RPC. Raise REORG_MAX_DEPTH if you really need more.'
    });
  }
  if (!Number.isFinite(extra) || extra < 0 || extra > 100) throw new HttpError(400, 'extra must be between 0 and 100');

  // An auto-mine tick firing mid reorg produces nonsense.
  if (isAutoMineRunning() && !force) {
    throw new HttpError(409, 'Auto-mine is running. Stop it first, or pass force: true.', {
      details: { autoMine: autoMineStatus() }
    });
  }

  const height = await bitcoinRPC('getblockcount');
  if (depth > height) {
    throw new HttpError(400, `Cannot reorg ${depth} blocks: the chain is only ${height} blocks long`, {
      details: { height, maxDepth: height }
    });
  }

  const before = {
    height,
    bestBlockHash: await bitcoinRPC('getbestblockhash', [], false, { quiet: true }),
    mempoolSize: (await bitcoinRPC('getmempoolinfo', [], false, { quiet: true })).size,
    balanceBtc: (await bitcoinRPC('getbalances', [], true, { quiet: true })).mine.trusted
  };

  // Record the doomed blocks before invalidating; afterwards they are no longer
  // reachable by height.
  const invalidateHeight = height - depth + 1;
  const disconnectedBlocks = [];
  for (let h = height; h >= invalidateHeight; h--) {
    disconnectedBlocks.push(await bitcoinRPC('getblockhash', [h], false, { quiet: true }));
  }
  const invalidatedHash = disconnectedBlocks[disconnectedBlocks.length - 1];

  // This can stall the node for a while on a deep reorg.
  await bitcoinRPC('invalidateblock', [invalidatedHash], false, { timeoutMs: 300000 });

  const mineTo = await resolveMiningAddress(body.mineTo || null);
  const toMine = depth + extra;
  let minedBlocks = [];

  if (includeMempool) {
    minedBlocks = await bitcoinRPC('generatetoaddress', [toMine, mineTo], false, { timeoutMs: 300000 });
  } else {
    // Disconnected blocks put their transactions back in the mempool, so a
    // plain generatetoaddress just re-confirms the very transactions the reorg
    // was supposed to unconfirm. Empty blocks are what makes a reorg testable.
    for (let i = 0; i < toMine; i++) {
      minedBlocks.push(await bitcoinRPC('generateblock', [mineTo, []], false, { timeoutMs: 60000 }).then((r) => r.hash));
    }
  }

  const after = {
    height: await bitcoinRPC('getblockcount', [], false, { quiet: true }),
    bestBlockHash: await bitcoinRPC('getbestblockhash', [], false, { quiet: true }),
    mempoolSize: (await bitcoinRPC('getmempoolinfo', [], false, { quiet: true })).size,
    balanceBtc: (await bitcoinRPC('getbalances', [], true, { quiet: true })).mine.trusted
  };

  // Which wallet transactions the reorg actually disturbed.
  const walletImpact = { conflicted: [], unconfirmed: [] };
  try {
    const recent = await bitcoinRPC('listtransactions', ['*', 100, 0, true], true, { quiet: true });
    for (const t of recent) {
      if (t.confirmations < 0) walletImpact.conflicted.push(t.txid);
      else if (t.confirmations === 0) walletImpact.unconfirmed.push(t.txid);
    }
    walletImpact.conflicted = [...new Set(walletImpact.conflicted)];
    walletImpact.unconfirmed = [...new Set(walletImpact.unconfirmed)];
  } catch (e) {
    walletImpact.error = e.message;
  }

  res.json({
    success: true,
    depth,
    extra,
    includeMempool,
    before,
    invalidated: { height: invalidateHeight, blockHash: invalidatedHash },
    disconnectedBlocks,
    minedBlocks,
    after,
    walletImpact,
    note: includeMempool
      ? 'Transactions from the disconnected blocks returned to the mempool and were most likely mined straight back in. Pass includeMempool: false to mine empty blocks and leave them unconfirmed.'
      : 'Empty blocks were mined, so transactions from the disconnected blocks are still unconfirmed in the mempool.',
    undo: {
      note: 'The old blocks stay marked invalid, which is what stops the node switching back. Reconsidering will reactivate that chain if it is longer.',
      endpoint: 'POST /api/chain/reconsider',
      body: { blockHash: invalidatedHash }
    }
  });
}));

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

// Deliberately polls rather than using bitcoind's waitforblockheight: each
// blocked call there occupies one of bitcoind's 4 default RPC worker threads,
// so a handful of concurrent waiters would stall every other RPC including the
// dashboard's own refresh. A getblockcount against a local node costs ~1ms.
async function pollUntil(check, { timeoutMs, intervalMs, signal }) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    const result = await check();
    if (result.done) {
      return Object.assign({ satisfied: true, timedOut: false, waitedMs: Date.now() - started }, result.state);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Object.assign({ satisfied: false, timedOut: true, waitedMs: Date.now() - started }, result.state);
    }
    await sleep(Math.min(intervalMs, remaining), undefined, { signal });
  }
}

function waitParams(req) {
  const rawTimeout = parseInt(req.query.timeout, 10);
  const requested = Number.isFinite(rawTimeout) ? rawTimeout : 30;
  const seconds = Math.min(cfg.WAIT_MAX_TIMEOUT_SECONDS, Math.max(1, requested));
  const rawInterval = parseInt(req.query.interval, 10);
  const intervalMs = Math.min(5000, Math.max(100, Number.isFinite(rawInterval) ? rawInterval : 500));
  return { timeoutMs: seconds * 1000, intervalMs, timeoutClamped: requested !== seconds, timeoutSeconds: seconds };
}

// Returns a 200 in both the satisfied and the timed-out case, with explicit
// booleans, so an ordinary timeout is not treated as a transport error by
// curl --fail or a naive `if (!response.ok)` wrapper.
function waitHandler(buildCheck) {
  return asyncHandler(async (req, res) => {
    const { timeoutMs, intervalMs, timeoutClamped, timeoutSeconds } = waitParams(req);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const check = await buildCheck(req);

    let out;
    try {
      out = await pollUntil(check, { timeoutMs, intervalMs, signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') return; // client hung up, write nothing
      throw e;
    }
    if (res.writableEnded) return;

    res.set('Cache-Control', 'no-store');
    res.json(Object.assign(out, { timeoutSeconds, timeoutClamped }));
  });
}

router.get('/wait/height/:height', waitHandler(async (req) => {
  const target = parseInt(req.params.height, 10);
  if (!Number.isFinite(target) || target < 0) throw new HttpError(400, 'height must be a non-negative integer');
  return async () => {
    const height = await bitcoinRPC('getblockcount', [], false, { quiet: true });
    return { done: height >= target, state: { height, target: { height: target } } };
  };
}));

router.get('/wait/tx/:txid', waitHandler(async (req) => {
  const txid = String(req.params.txid);
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new HttpError(400, 'txid must be 64 hex characters');
  // `|| 1` would defeat confirmations=0, because 0 is falsy: the one value
  // Math.max(0, ...) exists to allow. Parse the way every other numeric
  // default in this file does.
  const rawConfirmations = parseInt(req.query.confirmations, 10);
  const wanted = Math.max(0, Number.isFinite(rawConfirmations) ? rawConfirmations : 1);

  return async () => {
    let confirmations = null;
    let inMempool = false;
    let blockHash = null;
    try {
      // txindex is enabled, so this also works for transactions the wallet does
      // not own.
      const tx = await bitcoinRPC('getrawtransaction', [txid, true], false, { quiet: true });
      confirmations = tx.confirmations || 0;
      blockHash = tx.blockhash || null;
      inMempool = confirmations === 0;
    } catch (e) {
      confirmations = null;
    }
    return {
      done: confirmations !== null && confirmations >= wanted,
      state: { txid, confirmations, inMempool, blockHash, target: { confirmations: wanted } }
    };
  };
}));

router.get('/wait/mempool/:txid', waitHandler(async (req) => {
  const txid = String(req.params.txid);
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new HttpError(400, 'txid must be 64 hex characters');
  return async () => {
    const mempool = await bitcoinRPC('getrawmempool', [false], false, { quiet: true });
    const present = Array.isArray(mempool) && mempool.includes(txid);
    return { done: present, state: { txid, inMempool: present, mempoolSize: mempool.length } };
  };
}));

// ---------------------------------------------------------------------------
// Aggregate status
// ---------------------------------------------------------------------------

router.get('/status', asyncHandler(async (req, res) => {
  const pkg = require('../package.json');
  const errors = [];

  const settle = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors.push({ subsystem: name, message: e.message, rpcCode: e.rpcCode });
      return null;
    }
  };

  const [chainInfo, mempoolInfo, networkInfo, balances, walletInfo, electrsUp] = await Promise.all([
    settle('chain', () => bitcoinRPC('getblockchaininfo', [], false, { quiet: true })),
    settle('mempool', () => bitcoinRPC('getmempoolinfo', [], false, { quiet: true })),
    settle('node', () => bitcoinRPC('getnetworkinfo', [], false, { quiet: true })),
    settle('wallet', () => bitcoinRPC('getbalances', [], true, { quiet: true })),
    settle('wallet', () => bitcoinRPC('getwalletinfo', [], true, { quiet: true })),
    settle('electrs', () => checkElectrsTCP())
  ]);

  res.json({
    ok: errors.length === 0,
    time: new Date().toISOString(),
    dashboard: {
      version: pkg.version,
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      apiAuth: cfg.API_TOKEN ? 'required' : 'disabled',
      nodeVersion: process.version
    },
    chain: chainInfo && {
      chain: chainInfo.chain,
      blocks: chainInfo.blocks,
      headers: chainInfo.headers,
      bestBlockHash: chainInfo.bestblockhash,
      initialBlockDownload: chainInfo.initialblockdownload,
      medianTime: chainInfo.mediantime,
      difficulty: chainInfo.difficulty
    },
    mempool: mempoolInfo && { size: mempoolInfo.size, bytes: mempoolInfo.bytes, usage: mempoolInfo.usage },
    wallet: (balances || walletInfo) && {
      name: walletInfo ? walletInfo.walletname : cfg.RPC_WALLET,
      loaded: !!walletInfo,
      descriptors: walletInfo ? walletInfo.descriptors : null,
      txCount: walletInfo ? walletInfo.txcount : null,
      balanceBtc: balances && {
        trusted: balances.mine.trusted,
        untrustedPending: balances.mine.untrusted_pending,
        immature: balances.mine.immature
      }
    },
    mining: { autoMine: autoMineStatus() },
    node: networkInfo && {
      version: networkInfo.version,
      subversion: networkInfo.subversion,
      connections: networkInfo.connections,
      warnings: networkInfo.warnings
    },
    electrs: { reachable: !!electrsUp, host: cfg.ELECTRS_HOST, port: parseInt(cfg.ELECTRS_PORT, 10) },
    errors
  });
}));

module.exports = router;
