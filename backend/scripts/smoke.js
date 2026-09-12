#!/usr/bin/env node
// End to end smoke test against a running dashboard.
//
//   node scripts/smoke.js [baseUrl] [--token=xxx] [--destructive]
//
// Exercises every documented endpoint. Read-only and additive calls run by
// default; --destructive also runs chain reset and reconsider.

const BASE = (process.argv.find((a) => a.startsWith('http')) || process.env.SMOKE_BASE || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = (process.argv.find((a) => a.startsWith('--token=')) || '').split('=')[1] || process.env.API_TOKEN || '';
const DESTRUCTIVE = process.argv.includes('--destructive');

let passed = 0;
let failed = 0;
const failures = [];

function headers(extra) {
  return Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}, extra || {});
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function expectOk(method, path, body) {
  const r = await call(method, path, body);
  assert(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

(async () => {
  console.log(`Smoke testing ${BASE}${TOKEN ? ' (with token)' : ''}\n`);

  console.log('Discovery');
  let index;
  await check('GET /api', async () => {
    index = await expectOk('GET', '/api');
    assert(index.openapi, 'missing openapi link');
    assert(index.groups && Object.keys(index.groups).length > 5, 'missing endpoint groups');
  });
  await check('GET /api/openapi.json', async () => {
    const spec = await expectOk('GET', '/api/openapi.json');
    assert(spec.openapi.startsWith('3.1'), 'not an OpenAPI 3.1 document');
    assert(Object.keys(spec.paths).length > 50, 'suspiciously few documented paths');
  });
  await check('GET /api/llms.txt is plain text', async () => {
    const r = await call('GET', '/api/llms.txt');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.contentType.includes('text/plain'), `content-type was ${r.contentType}`);
    assert(r.text.includes('POST /api/faucet'), 'faucet missing from the cheat sheet');
  });
  await check('GET /api/health', async () => {
    const h = await expectOk('GET', '/api/health');
    assert(h.status === 'ok', `status ${h.status}`);
    assert(h.auth && typeof h.auth.required === 'boolean', 'health should report auth state');
  });
  await check('unknown /api path returns JSON 404, not the SPA', async () => {
    const r = await call('GET', '/api/definitely-not-a-real-endpoint');
    assert(r.status === 404, `expected 404, got ${r.status}`);
    assert(r.json && r.json.error, `expected a JSON error body, got ${r.text.slice(0, 80)}`);
  });

  console.log('\nStatus and connection');
  let chain = 'unknown';
  await check('GET /api/status', async () => {
    const s = await expectOk('GET', '/api/status');
    assert(s.chain, 'no chain block');
    chain = s.chain.chain;
    assert(s.dashboard && s.dashboard.version, 'no dashboard version');
  });
  await check('GET /api/connection', async () => {
    const c = await expectOk('GET', '/api/connection');
    assert(c.bitcoinRpc && c.bitcoinRpc.url, 'no rpc url');
    assert(c.recipes && c.recipes.fund, 'no recipes');
  });

  console.log('\nNode, mempool, blocks');
  for (const path of ['/api/blockchain/info', '/api/network/info', '/api/network/peers',
                      '/api/mining/info', '/api/mempool/info', '/api/mempool/raw',
                      '/api/block/best', '/api/block/height/0', '/api/wallet/info',
                      '/api/wallet/balance', '/api/wallet/list', '/api/wallet/addresses',
                      '/api/wallet/transactions', '/api/wallet/utxos', '/api/mine/auto/status',
                      '/api/estimatesmartfee/6', '/api/wallet/descriptors']) {
    await check(`GET ${path}`, () => expectOk('GET', path));
  }
  await check('GET /api/block/best is reachable (not shadowed by :hash)', async () => {
    const best = await expectOk('GET', '/api/block/best');
    assert(best.hash && /^[0-9a-f]{64}$/.test(best.hash), `expected a block hash, got ${JSON.stringify(best).slice(0, 120)}`);
  });
  await check('GET /api/block/:hash', async () => {
    const best = await expectOk('GET', '/api/block/best');
    const block = await expectOk('GET', `/api/block/${best.hash}`);
    assert(block.hash === best.hash, 'hash mismatch');
  });

  console.log('\nLogs');
  let bitcoindLogsAvailable = false;
  await check('GET /api/logs/sources', async () => {
    const s = await expectOk('GET', '/api/logs/sources');
    assert(Array.isArray(s.sources), 'no sources array');
    const bd = s.sources.find((x) => x.id === 'bitcoind');
    bitcoindLogsAvailable = bd && bd.available;
    if (!bitcoindLogsAvailable) console.log(`       note: bitcoind logs unavailable (${bd && bd.reason}) - ${bd && bd.detail}`);
  });
  await check('GET /api/logs/server', async () => {
    const l = await expectOk('GET', '/api/logs/server?limit=20');
    assert(Array.isArray(l.entries), 'no entries');
  });
  await check('GET /api/logs/rpc has captured calls', async () => {
    const l = await expectOk('GET', '/api/logs/rpc?limit=20');
    assert(Array.isArray(l.entries), 'no entries');
    assert(l.entries.length > 0, 'expected some RPC calls to have been recorded by now');
    assert(l.entries[0].method && typeof l.entries[0].durationMs === 'number', 'entries are not structured');
  });
  await check('GET /api/logs/bitcoind', async () => {
    const r = await call('GET', '/api/logs/bitcoind?lines=20');
    if (bitcoindLogsAvailable) {
      assert(r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
      assert(Array.isArray(r.json.lines), 'no lines array');
    } else {
      assert(r.status === 404 || r.status === 403, `expected 404/403 when unavailable, got ${r.status}`);
      assert(r.json.hint, 'an unavailable log should explain why');
    }
  });
  await check('log filter rejects a bad regex with 400', async () => {
    const r = await call('GET', '/api/logs/bitcoind?filter=' + encodeURIComponent('([') + '&regex=true');
    assert(r.status === 400 || r.status === 404 || r.status === 403, `expected 400, got ${r.status}`);
  });
  await check('GET /api/logs/debug-categories', async () => {
    const c = await expectOk('GET', '/api/logs/debug-categories');
    assert(c.categories && typeof c.categories === 'object', 'no categories');
  });
  await check('POST /api/logs/debug-categories rejects an unknown category', async () => {
    const r = await call('POST', '/api/logs/debug-categories', { include: ['not_a_real_category'] });
    assert(r.status === 400, `expected 400, got ${r.status}`);
    assert(r.json.details && r.json.details.validCategories, 'should list the valid categories');
  });

  if (chain !== 'regtest') {
    console.log(`\nSkipping mining and faucet checks: chain is ${chain}, not regtest.`);
  } else {
    console.log('\nMining and faucet');
    let address;
    await check('POST /api/wallet/newaddress', async () => {
      const a = await expectOk('POST', '/api/wallet/newaddress', { addressType: 'bech32' });
      assert(a.address && a.address.startsWith('bcrt1'), `unexpected address ${a.address}`);
      address = a.address;
    });
    await check('POST /api/mine', async () => {
      const m = await expectOk('POST', '/api/mine', { blocks: 1 });
      assert(m.success && m.hashes.length === 1, 'did not mine one block');
    });
    await check('GET /api/validateaddress/:address', async () => {
      const v = await expectOk('GET', `/api/validateaddress/${address}`);
      assert(v.isvalid, 'address should be valid');
    });
    await check('POST /api/faucet funds an address and confirms it', async () => {
      const f = await expectOk('POST', '/api/faucet', { address, amount: 0.001, confirmations: 1 });
      assert(f.txid, 'no txid');
      assert(f.confirmations >= 1, `expected a confirmation, got ${f.confirmations}`);
      assert(f.vout !== null, 'faucet should report the outpoint');
    });
    await check('POST /api/faucet rejects an invalid address', async () => {
      const r = await call('POST', '/api/faucet', { address: 'not-an-address', amount: 0.001 });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });
    await check('POST /api/faucet honours idempotencyKey', async () => {
      const key = 'smoke-' + Date.now();
      const a = await expectOk('POST', '/api/faucet', { address, amount: 0.001, idempotencyKey: key });
      const b = await expectOk('POST', '/api/faucet', { address, amount: 0.001, idempotencyKey: key });
      assert(a.txid === b.txid, 'the same key produced two different transactions');
    });

    console.log('\nWait helpers');
    await check('GET /api/wait/height satisfied immediately', async () => {
      const info = await expectOk('GET', '/api/blockchain/info');
      const w = await expectOk('GET', `/api/wait/height/${info.blocks}?timeout=5`);
      assert(w.satisfied === true && w.timedOut === false, `unexpected ${JSON.stringify(w)}`);
    });
    await check('GET /api/wait/height times out with 200 and timedOut:true', async () => {
      const info = await expectOk('GET', '/api/blockchain/info');
      const r = await call('GET', `/api/wait/height/${info.blocks + 5000}?timeout=2`);
      assert(r.status === 200, `expected 200 on timeout, got ${r.status}`);
      assert(r.json.timedOut === true && r.json.satisfied === false, `unexpected ${JSON.stringify(r.json)}`);
    });
    await check('GET /api/wait/tx rejects a malformed txid', async () => {
      const r = await call('GET', '/api/wait/tx/nope?timeout=2');
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    console.log('\nReorg');
    await check('POST /api/chain/reorg with empty blocks', async () => {
      const before = await expectOk('GET', '/api/blockchain/info');
      const r = await expectOk('POST', '/api/chain/reorg', { depth: 2, extra: 1, includeMempool: false });
      assert(r.success, 'reorg did not report success');
      assert(r.before.bestBlockHash !== r.after.bestBlockHash, 'the tip did not change');
      assert(r.after.height === before.blocks + 1, `expected height ${before.blocks + 1}, got ${r.after.height}`);
      assert(r.disconnectedBlocks.length === 2, 'wrong disconnected block count');
    });
    await check('POST /api/chain/reorg rejects depth beyond the chain', async () => {
      const r = await call('POST', '/api/chain/reorg', { depth: 999999 });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });
  }

  console.log('\nElectrs');
  for (const path of ['/api/electrs/health', '/api/electrs/info', '/api/electrs/blocks/tip/height', '/api/electrs/fee-estimates']) {
    await check(`GET ${path}`, async () => {
      const r = await call('GET', path);
      // Electrs may legitimately be offline or still syncing.
      assert(r.status === 200 || r.status === 500 || r.status === 503, `unexpected status ${r.status}`);
    });
  }

  console.log('\nRPC passthrough');
  await check('POST /api/rpc', async () => {
    const r = await expectOk('POST', '/api/rpc', { method: 'getblockcount', params: [] });
    assert(typeof r.result === 'number', 'expected a block count');
  });
  await check('POST /api/rpc surfaces an unknown method', async () => {
    const r = await call('POST', '/api/rpc', { method: 'thismethoddoesnotexist', params: [] });
    assert(r.status >= 400, `expected an error status, got ${r.status}`);
  });

  if (DESTRUCTIVE) {
    console.log('\nDestructive');
    await check('POST /api/chain/reset requires confirmation', async () => {
      const r = await call('POST', '/api/chain/reset', {});
      assert(r.status === 400, `expected 400 without confirmation, got ${r.status}`);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error('\nSmoke run crashed:', e.message);
  process.exit(1);
});
