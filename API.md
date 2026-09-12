# Bitcoin Regtest Dashboard API

A local HTTP API for driving a Bitcoin regtest network: mine blocks, fund addresses,
trigger reorgs, inspect blocks, transactions and the mempool, and read Bitcoin Core's logs.

It is designed to be driven by something other than a human: a test suite, a script, or an
AI agent troubleshooting a wallet, a swap service or any other app pointed at this node.

Base URL: `http://localhost:3000/api` (port 3000 by default).

## Start here

Three endpoints exist so a client can work the rest out on its own:

| Endpoint | What it gives you |
| --- | --- |
| `GET /api` | Compact index: every endpoint grouped by area, whether a token is required, quickstart commands. About 2 KB. |
| `GET /api/llms.txt` | The whole API as plain text, roughly 8 KB, including the gotchas below. Cheapest way for an agent to learn the API in one fetch. |
| `GET /api/openapi.json` | Full OpenAPI 3.1 specification, for code generation and tooling. |

All three are reachable without a token even when one is configured, so a client can always
discover that it needs to authenticate.

```bash
curl -s http://localhost:3000/api | jq
curl -s http://localhost:3000/api/llms.txt
```

## Conventions

- Everything is JSON. Errors are `{"error": "...", "rpcCode"?: -6, "hint"?: "..."}` with a 4xx or 5xx status.
- `rpcCode` is Bitcoin Core's own JSON-RPC error code, when the failure came from the node.
- An unknown `/api` path returns a JSON 404, not the dashboard HTML.

## Things that will otherwise cost you an hour

- **Regtest coinbase needs 100 confirmations to mature.** A freshly created chain has a zero
  spendable balance no matter how many blocks were mined. `POST /api/faucet` handles this for
  you by mining until there is a mature balance.
- **The block subsidy is not 50 BTC.** Regtest halves every 150 blocks, so by height 151 it is
  already 25 BTC. Do not compute block counts from a fixed subsidy.
- **A reorg does not unconfirm anything by default.** Disconnected blocks put their transactions
  back in the mempool, and the replacement blocks mine those same transactions straight back in.
  Pass `includeMempool: false` to mine empty blocks, which is what actually leaves them unconfirmed.
- **bitcoind's RPC port is not published to the host.** The bundled compose file exposes 18443 on
  the Docker network only, to avoid clashing with any other Bitcoin node on the machine. Use
  `POST /api/rpc` to reach any RPC method from outside.
- **The wait endpoints answer HTTP 200 on timeout too.** Check `satisfied` and `timedOut` in the
  body rather than the status code.
- **Log filters only search the tail that was read**, not the whole file. The response reports
  `scannedLines` and `truncatedHead` so you can tell.

## Test driver

The endpoints worth knowing about, because they replace multi-step sequences that are easy to
get wrong.

### `POST /api/faucet`

Fund an address and confirm it in one call.

```bash
curl -sX POST http://localhost:3000/api/faucet \
  -H 'Content-Type: application/json' \
  -d '{"address":"bcrt1q...","amount":1,"confirmations":1}'
```

| Field | Default | Meaning |
| --- | --- | --- |
| `address` | a fresh wallet address | Where to send |
| `amount` | `1` | BTC |
| `confirmations` | `1` | Blocks to mine after sending. `0` leaves it in the mempool. |
| `feeRate` | `1` | sat/vB |
| `bootstrap` | `true` | Mine to create a spendable balance when the wallet is empty |
| `idempotencyKey` | none | Replays the previous response for 10 minutes, so a timed-out retry cannot double fund |

The response carries `txid`, `vout` (the exact outpoint, which is what you need when funding a
wallet under test), `blockHash`, `blockHeight` and a `bootstrap` block reporting any mining it
had to do.

### `POST /api/chain/reorg`

```bash
# Unconfirm the last 2 blocks worth of transactions
curl -sX POST http://localhost:3000/api/chain/reorg \
  -H 'Content-Type: application/json' \
  -d '{"depth":2,"extra":1,"includeMempool":false}'
```

Invalidates the last `depth` blocks and mines `depth + extra` to replace them. Returns the
before and after tips, the disconnected block hashes, and `walletImpact` listing which wallet
transactions became unconfirmed or conflicted.

`includeMempool: false` mines empty blocks. That is the mode you want for testing reorg
handling; the default re-confirms the same transactions.

The orphaned blocks stay marked invalid, which is what stops the node switching back to them.
`POST /api/chain/reconsider` with the returned `blockHash` undoes that deliberately.

Regtest only. Returns 409 if auto-mine is running, unless you pass `force: true`.

### Wait helpers

```bash
curl -s "http://localhost:3000/api/wait/height/210?timeout=30"
curl -s "http://localhost:3000/api/wait/tx/<txid>?confirmations=1&timeout=30"
curl -s "http://localhost:3000/api/wait/mempool/<txid>?timeout=30"
```

Long-poll until the condition is met. Always HTTP 200; read `satisfied` and `timedOut`.
`timeout` is in seconds and is clamped rather than rejected (`timeoutClamped` tells you when).
`wait/tx` works for any transaction, not just wallet ones, because the node runs with `txindex`.

### `GET /api/status` and `GET /api/connection`

`status` is one call for chain, mempool, wallet, node, electrs and auto-mine state. It always
returns 200; a failed subsystem shows up as a null field plus an entry in `errors[]`.

`connection` returns everything needed to point another app at this node: the RPC URL and cookie
credentials, P2P and ZMQ endpoints, the Electrum connection string, and ready to run commands.
Credentials are withheld on any chain other than regtest.

## Logs

| Endpoint | Purpose |
| --- | --- |
| `GET /api/logs/sources` | What is available, and why anything is not |
| `GET /api/logs/bitcoind?lines=&filter=&regex=` | Tail Bitcoin Core's `debug.log` |
| `GET /api/logs/server?limit=&since=` | The dashboard's own console output |
| `GET /api/logs/rpc?errorsOnly=true` | Structured record of every RPC call, with duration and error |
| `GET /api/logs/stream?source=` | Follow live over server-sent events |
| `GET`/`POST /api/logs/debug-categories` | Read and set Bitcoin Core's logging categories at runtime |

```bash
curl -s "http://localhost:3000/api/logs/bitcoind?lines=100&filter=UpdateTip"
curl -s "http://localhost:3000/api/logs/rpc?errorsOnly=true" | jq
curl -sN "http://localhost:3000/api/logs/stream?source=bitcoind"
```

`/api/logs/rpc` is usually the fastest way to find out why an integration is failing: it records
the method, parameters, duration and the exact error for every call the dashboard made.

Turning on a debug category before reproducing a bug is often worth it:

```bash
curl -sX POST http://localhost:3000/api/logs/debug-categories \
  -H 'Content-Type: application/json' -d '{"include":["mempool","validation"]}'
```

If `debug.log` is unreadable the API says so explicitly (404 when missing, 403 on permissions)
with a hint, rather than failing vaguely. The bundled compose file chmods the file so the
dashboard container, which runs as uid 1000, can read it.

## Any RPC method

`POST /api/rpc` passes any method straight through to Bitcoin Core. This is the supported way to
reach the node from outside Docker.

```bash
curl -sX POST http://localhost:3000/api/rpc \
  -H 'Content-Type: application/json' \
  -d '{"method":"getblockchaininfo","params":[]}'
```

## Authentication

The API is open by default, which is appropriate for a disposable regtest node on a machine you
control. Set `API_TOKEN` on the dashboard service to require a token:

```yaml
environment:
  API_TOKEN: your-token-here
```

```bash
curl -s -H 'Authorization: Bearer your-token-here' http://localhost:3000/api/status
```

`X-API-Token` is accepted as well. For server-sent events use `?access_token=`, because
`EventSource` cannot set request headers.

`GET /api`, `GET /api/health` and `GET /api/openapi.json` stay reachable without a token so
clients can discover that one is needed. `GET /api/health` reports `auth.required`.

**Set a token if this dashboard is ever pointed at anything other than a throwaway regtest node.**
CORS is wide open by default, so without a token any web page the user visits can drive the node
through `POST /api/rpc`. `CORS_ORIGIN` narrows that if you need it.

## Deprecated endpoints

`importaddress`, `importprivkey` and `dumpprivkey` require a legacy BDB wallet, which Bitcoin
Core has removed. `POST /api/wallet/importaddress` and `POST /api/wallet/importprivkey` now fall
back to `importdescriptors` automatically, and the response says which path it took. Use
`GET /api/wallet/descriptors` in place of `dumpprivkey`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_TOKEN` | unset | Require a bearer token on `/api` |
| `CORS_ORIGIN` | `*` | Restrict which origins may call the API |
| `EXPOSE_RPC_CREDENTIALS` | `true` | Include the RPC cookie in `/api/connection` (regtest only regardless) |
| `BITCOIN_DEBUG_LOG` | derived from the cookie path | Where `debug.log` lives |
| `LOG_RPC` | `true` | Log every RPC call to stdout |
| `LOG_BUFFER_SIZE` | `2000` | Entries kept in the in-memory log buffers |
| `MAX_LOG_STREAMS` | `8` | Concurrent SSE log streams |
| `RPC_TIMEOUT_MS` | `0` (off) | Default timeout for RPC calls |
| `FAUCET_MAX_BOOTSTRAP_BLOCKS` | `600` | Cap on faucet auto-mining |
| `REORG_MAX_DEPTH` | `100` | Cap on reorg depth |
| `WAIT_MAX_TIMEOUT_SECONDS` | `120` | Cap on wait endpoint timeouts |

## Checking it yourself

```bash
cd backend
npm run check:api   # every route is documented, and none is shadowed
npm run smoke       # exercises every endpoint against a running dashboard
```
