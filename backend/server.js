const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Bitcoin RPC Configuration - Uses environment variables for Umbrel
const RPC_HOST = process.env.BITCOIN_RPC_HOST || 'bitcoin';
const RPC_PORT = process.env.BITCOIN_RPC_PORT || '18443';
const RPC_USER = process.env.BITCOIN_RPC_USER || 'umbrel';
const RPC_PASS = process.env.BITCOIN_RPC_PASS || 'moneyprintergobrrr';
const RPC_WALLET = process.env.BITCOIN_RPC_WALLET || 'regtest_wallet';

// Bitcoin RPC call helper
// useWallet: true for wallet-specific calls, false for node-level calls
async function bitcoinRPC(method, params = [], useWallet = false) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      jsonrpc: '1.0',
      id: Date.now(),
      method: method,
      params: params
    });

    // Use /wallet/<name> path for wallet-specific operations
    const path = useWallet ? `/wallet/${RPC_WALLET}` : '/';

    console.log(`RPC Call: ${method} useWallet=${useWallet} path=${path} host=${RPC_HOST}:${RPC_PORT}`);

    const options = {
      hostname: RPC_HOST,
      port: RPC_PORT,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64')
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log(`RPC Response for ${method}: ${data.substring(0, 200)}`);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || 'RPC Error'));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error('Failed to parse RPC response'));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const info = await bitcoinRPC('getblockchaininfo');
    res.json({ status: 'ok', chain: info.chain, blocks: info.blocks });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

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

    let miningAddress = address;

    // If no address provided, create a new one from the wallet
    if (!miningAddress) {
      try {
        miningAddress = await bitcoinRPC('getnewaddress', ['mining', 'bech32'], true);
      } catch (e) {
        // If wallet doesn't exist, create one
        if (e.message.includes('wallet')) {
          try {
            await bitcoinRPC('createwallet', ['regtest_wallet']);
            miningAddress = await bitcoinRPC('getnewaddress', ['mining', 'bech32'], true);
          } catch (walletError) {
            // Wallet might already exist, try loading it
            try {
              await bitcoinRPC('loadwallet', ['regtest_wallet']);
              miningAddress = await bitcoinRPC('getnewaddress', ['mining', 'bech32'], true);
            } catch (loadError) {
              throw new Error('Could not create or load wallet: ' + loadError.message);
            }
          }
        } else {
          throw e;
        }
      }
    }

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

// Get best block hash
app.get('/api/block/best', async (req, res) => {
  try {
    const hash = await bitcoinRPC('getbestblockhash');
    res.json({ hash });
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
    await bitcoinRPC('importaddress', [address, label, rescan], true);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import private key
app.post('/api/wallet/importprivkey', async (req, res) => {
  try {
    const { privkey, label = '', rescan = false } = req.body;
    await bitcoinRPC('importprivkey', [privkey, label, rescan], true);
    res.json({ success: true });
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
    res.status(500).json({ error: error.message });
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
      const blockHash = await bitcoinRPC('getblockhash', [1]);
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

// Serve frontend static files
app.use(express.static('/app/frontend'));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile('/app/frontend/index.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bitcoin Regtest Dashboard API running on port ${PORT}`);
  console.log(`Connecting to Bitcoin RPC at ${RPC_HOST}:${RPC_PORT}`);
});
