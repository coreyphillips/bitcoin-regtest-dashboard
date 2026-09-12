// Bitcoin Regtest Dashboard: HTTP API and static frontend.
//
// The API is documented at GET /api (index), GET /api/openapi.json (spec) and
// GET /api/llms.txt (compact reference). lib/operations.js is the source of
// truth for all three, and scripts/check-openapi.js fails the build when it
// disagrees with the routes registered below.

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const cfg = require('./lib/config');
const logbuffer = require('./lib/logbuffer');

// Patch the console before anything else is required, so startup logging
// (cookie reads, wallet initialization retries) is captured for /api/logs/server.
logbuffer.patchConsole();

const { bitcoinRPC, electrsRPC, checkElectrsTCP, getScripthashFromAddress } = require('./lib/rpc');
const { resolveMiningAddress, autoMineStatus, stopAutoMine, startAutoMine } = require('./lib/mining');
const { initializeWallet } = require('./lib/wallet');
const { requireToken } = require('./lib/auth');
const { apiNotFound, errorHandler } = require('./lib/http');
const metaRoutes = require('./routes/meta');
const logsRoutes = require('./routes/logs');
const driverRoutes = require('./routes/driver');

const ELECTRS_HOST = cfg.ELECTRS_HOST;
const ELECTRS_PORT = cfg.ELECTRS_PORT;

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: cfg.CORS_ORIGIN }));
app.use(bodyParser.json({ limit: '5mb' })); // raw transaction hex can be large

// ---------------------------------------------------------------------------
// Route order below is load bearing:
//   1. public discovery endpoints, reachable without a token
//   2. the auth gate
//   3. everything else under /api
//   4. a JSON 404 for unknown /api paths
//   5. the static frontend and its SPA catch-all
// Anything registered after the catch-all at the bottom is unreachable.
// ---------------------------------------------------------------------------

app.use('/api', metaRoutes.publicRouter);
app.use('/api', requireToken);
app.use('/api', metaRoutes.privateRouter);
app.use('/api', logsRoutes);
app.use('/api', driverRoutes);

// Get blockchain info
app.get('/api/blockchain/info', async (req, res) => {
  try {
    const info = await bitcoinRPC('getblockchaininfo');
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get network info
app.get('/api/network/info', async (req, res) => {
  try {
    const info = await bitcoinRPC('getnetworkinfo');
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get mining info
app.get('/api/mining/info', async (req, res) => {
  try {
    const info = await bitcoinRPC('getmininginfo');
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get mempool info
app.get('/api/mempool/info', async (req, res) => {
  try {
    const info = await bitcoinRPC('getmempoolinfo');
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get raw mempool
app.get('/api/mempool/raw', async (req, res) => {
  try {
    const verbose = req.query.verbose === 'true';
    const mempool = await bitcoinRPC('getrawmempool', [verbose]);
    res.json(mempool);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Mine blocks to address
app.post('/api/mine', async (req, res) => {
  try {
    const { blocks = 1, address } = req.body;
    const miningAddress = await resolveMiningAddress(address);

    const blockHashes = await bitcoinRPC('generatetoaddress', [parseInt(blocks), miningAddress]);
    res.json({
      success: true,
      blocks: blockHashes.length,
      hashes: blockHashes,
      address: miningAddress
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ---------------------------------------------------------------------------
// Auto-mine: a single server-side job that mines blocks at a fixed interval.
// By default it runs indefinitely until stopped; an optional duration makes it
// stop on its own at the deadline. It runs independently of any browser tab, so
// mining continues even if the dashboard is closed. Only one job at a time.
// The job itself lives in lib/mining.js.
// ---------------------------------------------------------------------------

// Start an auto-mine job
app.post('/api/mine/auto/start', async (req, res) => {
  try {
    if (autoMineStatus().running) {
      return res.status(409).json({ error: 'Auto-mine is already running. Stop it first.' });
    }

    // Duration is optional: when omitted the job runs until it is stopped.
    const durationRaw = req.body.durationMinutes;
    const hasDuration = durationRaw !== undefined && durationRaw !== null && durationRaw !== '';
    const durationMinutes = hasDuration ? parseInt(durationRaw, 10) : null;
    const intervalSeconds = parseInt(req.body.intervalSeconds, 10);
    const blocksPerTick = parseInt(req.body.blocks, 10) || 1;
    const address = req.body.address || null;

    if (hasDuration && (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)) {
      return res.status(400).json({ error: 'Duration must be between 1 and 1440 minutes' });
    }
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
      return res.status(400).json({ error: 'Interval must be at least 1 second' });
    }
    if (blocksPerTick < 1 || blocksPerTick > 1000) {
      return res.status(400).json({ error: 'Blocks per tick must be between 1 and 1000' });
    }

    const status = await startAutoMine({ durationMinutes, intervalSeconds, blocksPerTick, address });
    res.json(status);
  } catch (error) {
    stopAutoMine();
    res.status(500).json({ error: error.message });
  }
});

// Stop the auto-mine job
app.post('/api/mine/auto/stop', (req, res) => {
  const status = autoMineStatus();
  stopAutoMine();
  res.json({ running: false, stopped: status.running, blocksMined: status.blocksMined || 0 });
});

// Get auto-mine status
app.get('/api/mine/auto/status', (req, res) => {
  res.json(autoMineStatus());
});

// Get wallet info
app.get('/api/wallet/info', async (req, res) => {
  try {
    const info = await bitcoinRPC('getwalletinfo', [], true);
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get wallet balance
app.get('/api/wallet/balance', async (req, res) => {
  try {
    // Use getbalances which works in modern Bitcoin Core versions
    const balances = await bitcoinRPC('getbalances', [], true);
    const confirmed = balances.mine ? balances.mine.trusted : 0;
    const unconfirmed = balances.mine ? (balances.mine.untrusted_pending || 0) : 0;
    res.json({ confirmed: confirmed, unconfirmed: unconfirmed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List wallets
app.get('/api/wallet/list', async (req, res) => {
  try {
    const wallets = await bitcoinRPC('listwallets');
    res.json(wallets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create wallet
app.post('/api/wallet/create', async (req, res) => {
  try {
    const { name, disablePrivateKeys = false, blank = false, passphrase = '', avoidReuse = false, descriptors = true } = req.body;
    const result = await bitcoinRPC('createwallet', [name, disablePrivateKeys, blank, passphrase, avoidReuse, descriptors]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Load wallet
app.post('/api/wallet/load', async (req, res) => {
  try {
    const { name } = req.body;
    const result = await bitcoinRPC('loadwallet', [name]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get new address
app.post('/api/wallet/newaddress', async (req, res) => {
  try {
    const { label = '', addressType = 'bech32' } = req.body;
    const address = await bitcoinRPC('getnewaddress', [label, addressType], true);
    res.json({ address });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List addresses
app.get('/api/wallet/addresses', async (req, res) => {
  try {
    const addresses = await bitcoinRPC('listreceivedbyaddress', [0, true], true);
    res.json(addresses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send to address
app.post('/api/wallet/send', async (req, res) => {
  try {
    const { address, amount, comment = '', commentTo = '', subtractFee = false, replaceable = true, feeRate = 1 } = req.body;

    // Use fee_rate (sat/vB) instead of conf_target to avoid fee estimation issues on regtest
    const txid = await bitcoinRPC('sendtoaddress', [
      address,
      parseFloat(amount),
      comment,
      commentTo,
      subtractFee,
      replaceable,
      null,           // conf_target - null to skip
      "unset",        // estimate_mode
      false,          // avoid_reuse
      parseFloat(feeRate)  // fee_rate in sat/vB
    ], true);

    res.json({ txid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send many
app.post('/api/wallet/sendmany', async (req, res) => {
  try {
    const { amounts, comment = '', subtractFeeFrom = [], replaceable = true, feeRate = 1 } = req.body;

    // Use fee_rate instead of conf_target to avoid fee estimation issues on regtest
    const txid = await bitcoinRPC('sendmany', [
      '',
      amounts,
      1,
      comment,
      subtractFeeFrom,
      replaceable,
      null,           // conf_target - null to skip
      "unset",        // estimate_mode
      parseFloat(feeRate)  // fee_rate in sat/vB
    ], true);

    res.json({ txid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get transaction
app.get('/api/transaction/:txid', async (req, res) => {
  try {
    const { txid } = req.params;
    const tx = await bitcoinRPC('gettransaction', [txid, true, true], true);
    res.json(tx);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get raw transaction
app.get('/api/transaction/:txid/raw', async (req, res) => {
  try {
    const { txid } = req.params;
    const verbose = req.query.verbose === 'true';
    const tx = await bitcoinRPC('getrawtransaction', [txid, verbose]);
    res.json({ raw: tx });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Decode raw transaction
app.post('/api/transaction/decode', async (req, res) => {
  try {
    const { hex } = req.body;
    const decoded = await bitcoinRPC('decoderawtransaction', [hex]);
    res.json(decoded);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List recent transactions
app.get('/api/wallet/transactions', async (req, res) => {
  try {
    const count = parseInt(req.query.count) || 20;
    const skip = parseInt(req.query.skip) || 0;
    const transactions = await bitcoinRPC('listtransactions', ['*', count, skip, true], true);
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List unspent outputs (UTXOs)
app.get('/api/wallet/utxos', async (req, res) => {
  try {
    const minconf = parseInt(req.query.minconf) || 0;
    const maxconf = parseInt(req.query.maxconf) || 9999999;
    const utxos = await bitcoinRPC('listunspent', [minconf, maxconf], true);
    res.json(utxos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// RBF - Bump fee (Replace-By-Fee)
app.post('/api/transaction/bumpfee', async (req, res) => {
  try {
    const { txid, options = {} } = req.body;
    const result = await bitcoinRPC('bumpfee', [txid, options], true);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel transaction (RBF to self)
app.post('/api/transaction/cancel', async (req, res) => {
  try {
    const { txid } = req.body;

    // Get the transaction details
    const tx = await bitcoinRPC('gettransaction', [txid, true, true], true);

    if (tx.confirmations > 0) {
      throw new Error('Transaction already confirmed, cannot cancel');
    }

    // Get a new address to send funds to (ourselves)
    const cancelAddress = await bitcoinRPC('getnewaddress', ['cancel', 'bech32'], true);

    // Decode the transaction to get input details and vsize
    const decoded = await bitcoinRPC('decoderawtransaction', [tx.hex]);

    // Calculate the original transaction's fee rate
    // tx.fee is negative (outgoing), so we use Math.abs
    const originalFeeBTC = Math.abs(tx.fee);
    const originalFeeSats = originalFeeBTC * 100000000;
    const originalVsize = decoded.vsize;
    const originalFeeRate = originalFeeSats / originalVsize;

    // Calculate new fee rate: original + 10 sat/vB (or at least 2x for very low fee txs)
    // BIP125 requires: new fee >= old fee + incremental relay fee (typically 1 sat/vB)
    // We use a higher increment to ensure quick replacement
    const minIncrement = 10; // sat/vB
    const newFeeRate = Math.max(
      Math.ceil(originalFeeRate + minIncrement),
      Math.ceil(originalFeeRate * 2), // At least double for very low fee txs
      2 // Absolute minimum
    );

    // Calculate total input value by looking up each input's previous output
    let totalInputValue = 0;
    for (const input of decoded.vin) {
      try {
        // Try to get the previous transaction from wallet
        const prevTx = await bitcoinRPC('gettransaction', [input.txid, true, true], true);
        const prevDecoded = await bitcoinRPC('decoderawtransaction', [prevTx.hex]);
        totalInputValue += prevDecoded.vout[input.vout].value;
      } catch (e) {
        // If not in wallet, try getrawtransaction
        const prevTxHex = await bitcoinRPC('getrawtransaction', [input.txid, true]);
        totalInputValue += prevTxHex.vout[input.vout].value;
      }
    }

    // Estimate the size of the replacement transaction
    // P2WPKH input: ~68 vbytes, P2WPKH output: ~31 vbytes, overhead: ~10 vbytes
    const estimatedVsize = decoded.vin.length * 68 + 31 + 10;
    const estimatedFee = (estimatedVsize * newFeeRate) / 100000000; // sat/vB to BTC

    // Calculate output amount: total inputs minus estimated fee
    // Round to 8 decimal places to avoid floating point issues
    const outputAmount = Math.round((totalInputValue - estimatedFee) * 100000000) / 100000000;

    if (outputAmount <= 0.00000546) { // Dust threshold
      throw new Error('Insufficient funds to cover cancellation fee');
    }

    // Use bumpfee with outputs to redirect all funds to our cancel address
    const result = await bitcoinRPC('bumpfee', [txid, {
      fee_rate: newFeeRate,
      outputs: [{ [cancelAddress]: outputAmount }]
    }], true);

    res.json({
      success: true,
      originalTxid: txid,
      replacementTxid: result.txid,
      cancelAddress: cancelAddress,
      originalFeeRate: Math.round(originalFeeRate * 100) / 100,
      newFeeRate: newFeeRate,
      newFee: result.fee,
      amountRecovered: outputAmount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Note: the specific block paths must stay registered before /api/block/:hash,
// otherwise the wildcard swallows them.
// Get best block hash
app.get('/api/block/best', async (req, res) => {
  try {
    const hash = await bitcoinRPC('getbestblockhash');
    res.json({ hash });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get block by height
app.get('/api/block/height/:height', async (req, res) => {
  try {
    const height = parseInt(req.params.height);
    const hash = await bitcoinRPC('getblockhash', [height]);
    const block = await bitcoinRPC('getblock', [hash, 1]);
    res.json(block);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get block by hash
app.get('/api/block/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    const verbosity = parseInt(req.query.verbosity) || 1;
    const block = await bitcoinRPC('getblock', [hash, verbosity]);
    res.json(block);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Estimate smart fee
app.get('/api/estimatesmartfee/:blocks', async (req, res) => {
  try {
    const blocks = parseInt(req.params.blocks);
    const result = await bitcoinRPC('estimatesmartfee', [blocks]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Validate address
app.get('/api/validateaddress/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const result = await bitcoinRPC('validateaddress', [address]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create raw transaction
app.post('/api/transaction/create', async (req, res) => {
  try {
    const { inputs, outputs, locktime = 0, replaceable = true } = req.body;
    const rawTx = await bitcoinRPC('createrawtransaction', [inputs, outputs, locktime, replaceable]);
    res.json({ hex: rawTx });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fund raw transaction
app.post('/api/transaction/fund', async (req, res) => {
  try {
    const { hex, options = {} } = req.body;
    const result = await bitcoinRPC('fundrawtransaction', [hex, options]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sign raw transaction with wallet
app.post('/api/transaction/sign', async (req, res) => {
  try {
    const { hex } = req.body;
    const result = await bitcoinRPC('signrawtransactionwithwallet', [hex], true);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send raw transaction
app.post('/api/transaction/send', async (req, res) => {
  try {
    const { hex, maxFeeRate } = req.body;
    const params = maxFeeRate ? [hex, maxFeeRate] : [hex];
    const txid = await bitcoinRPC('sendrawtransaction', params);
    res.json({ txid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test mempool accept
app.post('/api/transaction/testmempoolaccept', async (req, res) => {
  try {
    const { rawtxs, maxFeeRate } = req.body;
    const params = maxFeeRate ? [rawtxs, maxFeeRate] : [rawtxs];
    const result = await bitcoinRPC('testmempoolaccept', params);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get PSBT inputs
app.post('/api/psbt/create', async (req, res) => {
  try {
    const { inputs, outputs, locktime = 0, replaceable = true } = req.body;
    const psbt = await bitcoinRPC('createpsbt', [inputs, outputs, locktime, replaceable]);
    res.json({ psbt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Decode PSBT
app.post('/api/psbt/decode', async (req, res) => {
  try {
    const { psbt } = req.body;
    const result = await bitcoinRPC('decodepsbt', [psbt]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analyze PSBT
app.post('/api/psbt/analyze', async (req, res) => {
  try {
    const { psbt } = req.body;
    const result = await bitcoinRPC('analyzepsbt', [psbt]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Process PSBT (with wallet)
app.post('/api/psbt/process', async (req, res) => {
  try {
    const { psbt } = req.body;
    const result = await bitcoinRPC('walletprocesspsbt', [psbt], true);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Finalize PSBT
app.post('/api/psbt/finalize', async (req, res) => {
  try {
    const { psbt } = req.body;
    const result = await bitcoinRPC('finalizepsbt', [psbt]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import address (watch-only)
app.post('/api/wallet/importaddress', async (req, res) => {
  try {
    const { address, label = '', rescan = false } = req.body;
    try {
      await bitcoinRPC('importaddress', [address, label, rescan], true);
      res.json({ success: true, method: 'importaddress' });
    } catch (legacyError) {
      // importaddress needs a legacy wallet, which Bitcoin Core has removed.
      // Descriptor wallets watch an address via an addr() descriptor instead.
      const descriptor = await bitcoinRPC('getdescriptorinfo', [`addr(${address})`]);
      const result = await bitcoinRPC('importdescriptors', [[{
        desc: descriptor.descriptor,
        timestamp: rescan ? 0 : 'now',
        label: label,
        active: false,
        internal: false
      }]], true);
      const failure = Array.isArray(result) && result.find((r) => !r.success);
      if (failure) throw new Error(failure.error ? failure.error.message : 'importdescriptors failed');
      res.json({ success: true, method: 'importdescriptors', descriptor: descriptor.descriptor });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import private key
app.post('/api/wallet/importprivkey', async (req, res) => {
  try {
    const { privkey, label = '', rescan = false } = req.body;
    try {
      await bitcoinRPC('importprivkey', [privkey, label, rescan], true);
      res.json({ success: true, method: 'importprivkey' });
    } catch (legacyError) {
      // Legacy wallets are gone, so import the key as a wpkh() descriptor.
      const descriptor = await bitcoinRPC('getdescriptorinfo', [`wpkh(${privkey})`]);
      const result = await bitcoinRPC('importdescriptors', [[{
        desc: descriptor.descriptor,
        timestamp: rescan ? 0 : 'now',
        label: label
      }]], true);
      const failure = Array.isArray(result) && result.find((r) => !r.success);
      if (failure) throw new Error(failure.error ? failure.error.message : 'importdescriptors failed');
      res.json({ success: true, method: 'importdescriptors', descriptor: descriptor.descriptor });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dump private key
app.get('/api/wallet/dumpprivkey/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const privkey = await bitcoinRPC('dumpprivkey', [address], true);
    res.json({ privkey });
  } catch (error) {
    // dumpprivkey needs a legacy wallet, which Bitcoin Core has removed.
    res.status(500).json({
      error: error.message,
      hint: 'dumpprivkey requires a legacy wallet, which Bitcoin Core no longer supports. Use GET /api/wallet/descriptors to read the wallet keys instead.'
    });
  }
});

// Get address info
app.get('/api/wallet/addressinfo/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const info = await bitcoinRPC('getaddressinfo', [address], true);
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get peer info
app.get('/api/network/peers', async (req, res) => {
  try {
    const peers = await bitcoinRPC('getpeerinfo');
    res.json(peers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add node
app.post('/api/network/addnode', async (req, res) => {
  try {
    const { node, command = 'add' } = req.body;
    await bitcoinRPC('addnode', [node, command]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect node
app.post('/api/network/disconnectnode', async (req, res) => {
  try {
    const { address, nodeId } = req.body;
    if (nodeId) {
      await bitcoinRPC('disconnectnode', ['', nodeId]);
    } else {
      await bitcoinRPC('disconnectnode', [address]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset regtest chain - invalidates all blocks back to genesis
app.post('/api/chain/reset', async (req, res) => {
  try {
    const { confirm } = req.body;

    if (confirm !== 'RESET') {
      return res.status(400).json({
        error: 'Confirmation required. Send { "confirm": "RESET" } to proceed.',
        warning: 'This will invalidate all blocks and reset the chain to genesis. Your wallet will lose all coins.'
      });
    }

    // Get current block count
    const blockCount = await bitcoinRPC('getblockcount');

    if (blockCount === 0) {
      return res.json({ success: true, message: 'Chain is already at genesis block.' });
    }

    // Get block hash at height 1 (first block after genesis)
    const blockHash = await bitcoinRPC('getblockhash', [1]);

    // Invalidate block 1, which will invalidate all subsequent blocks
    await bitcoinRPC('invalidateblock', [blockHash]);

    // Reconsider the block to clear the invalid state but keep it pruned
    // Actually, we want to keep it invalid, so we won't reconsider

    // Create a new wallet to start fresh
    const timestamp = Date.now();
    const newWalletName = `regtest_wallet_${timestamp}`;

    try {
      await bitcoinRPC('createwallet', [newWalletName]);
    } catch (e) {
      // Wallet creation might fail, that's ok
      console.log('Note: Could not create new wallet:', e.message);
    }

    res.json({
      success: true,
      message: `Chain reset! Invalidated ${blockCount} blocks. Chain is now at height 0.`,
      note: 'Mine new blocks to rebuild the chain.',
      previousHeight: blockCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reconsider invalidated blocks (undo reset)
app.post('/api/chain/reconsider', async (req, res) => {
  try {
    // Get block hash at height 1
    try {
      // Defaults to height 1 (undoing a full chain reset) but accepts a
      // specific hash, which is what POST /api/chain/reorg hands back.
      const requested = req.body && req.body.blockHash;
      const blockHash = requested || await bitcoinRPC('getblockhash', [1]);
      await bitcoinRPC('reconsiderblock', [blockHash]);

      const newHeight = await bitcoinRPC('getblockcount');
      res.json({
        success: true,
        message: `Chain restored! Current height: ${newHeight}`,
        height: newHeight
      });
    } catch (e) {
      res.json({
        success: false,
        message: 'No invalidated blocks to reconsider, or chain is already at genesis.'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ============================================
// Electrs API Endpoints (Electrum Protocol)
// ============================================

// Check Electrs health/status
app.get('/api/electrs/health', async (req, res) => {
  try {
    const isConnected = await checkElectrsTCP();
    if (!isConnected) {
      return res.status(503).json({ status: 'offline', message: 'Electrs not reachable' });
    }

    // Get server banner/version using Electrum protocol
    const banner = await electrsRPC('server.banner');
    res.json({
      status: 'ok',
      banner: banner,
      host: ELECTRS_HOST,
      port: ELECTRS_PORT
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get Electrs connection info (for external wallets)
app.get('/api/electrs/info', async (req, res) => {
  try {
    const isConnected = await checkElectrsTCP();
    // Get the host from the request (how the user is accessing the dashboard)
    const host = req.hostname || req.headers.host?.split(':')[0] || 'localhost';
    const externalPort = process.env.ELECTRS_EXTERNAL_PORT || '60401';
    res.json({
      connected: isConnected,
      host: host,
      port: parseInt(externalPort),
      protocol: 'tcp',
      network: 'regtest',
      note: `Connect Electrum wallet with: electrum --regtest --oneserver --server ${host}:${externalPort}:t`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get address balance using Electrum protocol
app.get('/api/electrs/address/:address', async (req, res) => {
  try {
    const { address } = req.params;
    // Get scripthash from address for Electrum protocol
    const scripthash = await getScripthashFromAddress(address);
    const balance = await electrsRPC('blockchain.scripthash.get_balance', [scripthash]);
    const history = await electrsRPC('blockchain.scripthash.get_history', [scripthash]);

    res.json({
      address: address,
      chain_stats: {
        funded_txo_sum: balance.confirmed || 0,
        spent_txo_sum: 0, // Would need to calculate from history
        tx_count: history.length
      },
      mempool_stats: {
        funded_txo_sum: balance.unconfirmed || 0,
        spent_txo_sum: 0,
        tx_count: 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get address transactions using Electrum protocol
app.get('/api/electrs/address/:address/txs', async (req, res) => {
  try {
    const { address } = req.params;
    const scripthash = await getScripthashFromAddress(address);
    const history = await electrsRPC('blockchain.scripthash.get_history', [scripthash]);

    // History returns [{tx_hash, height}, ...]
    const txs = history.map(item => ({
      txid: item.tx_hash,
      status: {
        confirmed: item.height > 0,
        block_height: item.height > 0 ? item.height : null
      }
    }));

    res.json(txs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get address UTXOs using Electrum protocol
app.get('/api/electrs/address/:address/utxo', async (req, res) => {
  try {
    const { address } = req.params;
    const scripthash = await getScripthashFromAddress(address);
    const listunspent = await electrsRPC('blockchain.scripthash.listunspent', [scripthash]);

    // Convert to expected format
    const utxos = listunspent.map(utxo => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      value: utxo.value,
      status: {
        confirmed: utxo.height > 0,
        block_height: utxo.height > 0 ? utxo.height : null
      }
    }));

    res.json(utxos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get transaction from Electrs using Electrum protocol
app.get('/api/electrs/tx/:txid', async (req, res) => {
  try {
    const { txid } = req.params;
    const hex = await electrsRPC('blockchain.transaction.get', [txid, false]);
    res.json({ txid, hex });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Chain tip height as Electrs sees it. Comparing this against the node's own
// height is how you tell that Electrs has fallen behind.
app.get('/api/electrs/blocks/tip/height', async (req, res) => {
  try {
    const header = await electrsRPC('blockchain.headers.subscribe');
    res.json(header.height);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fee estimates keyed by confirmation target, in sat/vB.
app.get('/api/electrs/fee-estimates', async (req, res) => {
  try {
    const targets = [1, 2, 3, 6, 10, 20, 144, 504, 1008];
    const estimates = {};
    for (const target of targets) {
      try {
        // Electrum reports BTC per kvB; the rest of the world wants sat/vB.
        const btcPerKvb = await electrsRPC('blockchain.estimatefee', [target]);
        estimates[target] = btcPerKvb > 0 ? Math.round(btcPerKvb * 100000 * 1000) / 1000 : 1;
      } catch (e) {
        estimates[target] = 1;
      }
    }
    res.json(estimates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Descriptor-wallet replacements for the removed legacy import/dump RPCs.
app.get('/api/wallet/descriptors', async (req, res) => {
  try {
    const includePrivate = req.query.private !== 'false';
    const result = await bitcoinRPC('listdescriptors', [includePrivate], true);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/wallet/importdescriptors', async (req, res) => {
  try {
    const { requests } = req.body;
    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(400).json({ error: 'requests must be a non-empty array of importdescriptors request objects' });
    }
    const result = await bitcoinRPC('importdescriptors', [requests], true);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Generic RPC call (for advanced users)
app.post('/api/rpc', async (req, res) => {
  try {
    const { method, params = [] } = req.body;
    const result = await bitcoinRPC(method, params);
    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// A typo'd /api path must not fall through to the SPA catch-all below, which
// would answer 200 with HTML and make every client's JSON parse throw.
app.use('/api', apiNotFound);
app.use(errorHandler);

// Serve frontend static files. The container path wins when present; the
// relative path is what makes `npm start` work outside Docker.
const FRONTEND_DIR = process.env.FRONTEND_DIR ||
  (fs.existsSync('/app/frontend') ? '/app/frontend' : path.resolve(__dirname, '..', 'frontend'));
app.use(express.static(FRONTEND_DIR));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Exported so scripts/check-openapi.js can introspect the route table without
// starting a server. Keep the require.main guard below for that reason.
module.exports = app;

if (require.main === module) {
  app.listen(cfg.PORT, '0.0.0.0', () => {
    console.log(`Bitcoin Regtest Dashboard API running on port ${cfg.PORT}`);
    console.log(`Connecting to Bitcoin RPC at ${cfg.RPC_HOST}:${cfg.RPC_PORT}`);
    console.log(`API index: /api  |  OpenAPI: /api/openapi.json  |  Logs: /api/logs/sources`);
    console.log(`API auth: ${cfg.API_TOKEN ? 'bearer token required' : 'disabled (open)'}`);
    console.log(`Frontend served from ${FRONTEND_DIR}`);

    // Initialize wallet after server starts (Bitcoin Core may take time to be ready)
    initializeWallet().then(success => {
      if (success) {
        console.log('Wallet initialization complete.');
      } else {
        console.log('Warning: Wallet initialization failed. Some features may not work until Bitcoin Core is available.');
      }
    });
  });
}
