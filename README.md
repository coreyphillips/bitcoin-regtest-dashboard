# Bitcoin Regtest Dashboard

An Umbrel app for interacting with your Bitcoin regtest node during development.

## Features

- **Mine Blocks**: Mine 1, 10, 100, or custom number of blocks instantly
- **Send Bitcoin**: Send BTC to any address with RBF enabled by default
- **Generate Addresses**: Create new addresses (bech32, bech32m, p2sh-segwit, legacy)
- **RBF/Cancel Transactions**: Bump fees or cancel unconfirmed transactions
- **View UTXOs**: See all unspent transaction outputs in your wallet
- **Mempool Explorer**: View pending transactions in the mempool
- **Block Explorer**: Browse recent blocks and lookup by height/hash
- **Raw Transactions**: Decode, broadcast, and test raw transactions
- **RPC Console**: Execute any Bitcoin Core RPC command directly

## Installation on Umbrel

### Prerequisites

1. Umbrel OS running on your server
2. Bitcoin Node app installed and running in **regtest mode**

### Important: Configure Bitcoin for Regtest

Before installing this app, you need to configure your Bitcoin node to run in regtest mode. This requires modifying the Bitcoin configuration.

#### Option 1: Community App Store (Recommended)

If this app is available in a community app store:

1. Go to **Umbrel App Store**
2. Search for "Bitcoin Regtest Dashboard"
3. Click **Install**

#### Option 2: Manual Installation

Follow these steps to install the app manually on modern Umbrel (umbrelOS 1.0+):

**Step 1: SSH into your Umbrel**

```bash
ssh umbrel@umbrel.local
# Default password is usually: moneyprintergobrrr
```

**Step 2: Navigate to the app-data directory**

```bash
cd ~/umbrel/app-data
```

**Step 3: Clone or copy the app**

```bash
git clone https://github.com/coreyphillips/bitcoin-regtest-dashboard.git
```

Or transfer files from your local machine using `scp`:

```bash
# From your local machine (not on Umbrel)
scp -r /path/to/bitcoin-regtest-dashboard umbrel@umbrel.local:~/umbrel/app-data/
```

**Step 4: Restart Umbrel**

```bash
sudo reboot
```

After reboot, the app should appear in your Umbrel dashboard.

### Alternative: Using Docker Compose Directly

If you want to run the dashboard without full Umbrel integration:

**Step 1: Build the Docker image**

```bash
cd /path/to/bitcoin-regtest-dashboard
docker build -t bitcoin-regtest-dashboard .
```

**Step 2: Run with Docker**

```bash
docker run -d \
  --name bitcoin-regtest-dashboard \
  -p 3000:3000 \
  -e BITCOIN_RPC_HOST=<your-bitcoin-node-ip> \
  -e BITCOIN_RPC_PORT=18443 \
  -e BITCOIN_RPC_USER=umbrel \
  -e BITCOIN_RPC_PASS=moneyprintergobrrr \
  --network umbrel_main_network \
  bitcoin-regtest-dashboard
```

Replace `<your-bitcoin-node-ip>` with your Bitcoin node's IP address.

**Step 3: Access the dashboard**

Open your browser and go to: `http://umbrel.local:3000` or `http://<umbrel-ip>:3000`

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BITCOIN_RPC_HOST` | `bitcoin` | Bitcoin node hostname/IP |
| `BITCOIN_RPC_PORT` | `18443` | RPC port (18443 for regtest) |
| `BITCOIN_RPC_USER` | `umbrel` | RPC username |
| `BITCOIN_RPC_PASS` | `moneyprintergobrrr` | RPC password |
| `PORT` | `3000` | Dashboard web server port |

### Configuring Bitcoin Core for Regtest

Your `bitcoin.conf` should include:

```ini
# Network
regtest=1
[regtest]
rpcport=18443
rpcbind=0.0.0.0
rpcallowip=0.0.0.0/0
server=1

# RPC credentials
rpcuser=umbrel
rpcpassword=moneyprintergobrrr

# Enable wallet
disablewallet=0

# Useful settings for development
txindex=1
fallbackfee=0.00001
```

## Usage

### Quick Actions

The dashboard provides quick action buttons at the top:

- **Mine 1/10/100 Blocks**: Instantly mine blocks to your wallet
- **New Address**: Generate a new bech32 address (copies to clipboard)
- **Refresh**: Manually refresh all dashboard data

### Mining Tab

- Enter the number of blocks to mine
- Optionally specify a destination address
- Click "Mine" to generate blocks

### Wallet Tab

- **Send Bitcoin**: Send BTC to any address with optional RBF
- **Generate Address**: Create addresses of any type with custom labels
- **View Balance**: See confirmed and unconfirmed balances
- **UTXOs**: List all unspent outputs

### Transactions Tab

- **RBF - Bump Fee**: Increase the fee on an unconfirmed transaction
- **Cancel TX**: Cancel an unconfirmed transaction (RBF to self)
- **Lookup Transaction**: Get full details of any transaction
- **Recent Transactions**: View your transaction history

### Mempool Tab

- View mempool statistics
- List all pending transactions

### Blocks Tab

- Lookup blocks by height or hash
- View recent blocks with transaction counts

### Raw TX Tab

- **Decode**: Parse raw transaction hex
- **Broadcast**: Submit signed transactions to the network
- **Test Accept**: Test if a transaction would be accepted without broadcasting

### RPC Console Tab

- Execute any Bitcoin Core RPC command
- Quick buttons for common commands
- Full JSON parameter support

## API Endpoints

The backend exposes a REST API you can use directly:

### Blockchain
- `GET /api/blockchain/info` - Get blockchain info
- `GET /api/block/:hash` - Get block by hash
- `GET /api/block/height/:height` - Get block by height

### Mining
- `POST /api/mine` - Mine blocks `{ blocks: 1, address: "optional" }`

### Wallet
- `GET /api/wallet/balance` - Get wallet balance
- `GET /api/wallet/utxos` - List UTXOs
- `POST /api/wallet/newaddress` - Generate address `{ addressType: "bech32", label: "" }`
- `POST /api/wallet/send` - Send BTC `{ address: "...", amount: 0.1, replaceable: true }`

### Transactions
- `GET /api/transaction/:txid` - Get transaction details
- `POST /api/transaction/bumpfee` - Bump fee `{ txid: "..." }`
- `POST /api/transaction/cancel` - Cancel transaction `{ txid: "..." }`
- `POST /api/transaction/decode` - Decode raw tx `{ hex: "..." }`
- `POST /api/transaction/send` - Broadcast raw tx `{ hex: "..." }`

### Mempool
- `GET /api/mempool/info` - Get mempool info
- `GET /api/mempool/raw?verbose=true` - Get mempool transactions

### Generic RPC
- `POST /api/rpc` - Execute any RPC `{ method: "getblockchaininfo", params: [] }`

## Troubleshooting

### "Connection failed" or "Disconnected"

1. Ensure Bitcoin node is running: `docker ps | grep bitcoin`
2. Check Bitcoin is in regtest mode
3. Verify RPC credentials match your bitcoin.conf
4. Check network connectivity between containers

### "Wallet not found" errors

The app will automatically create a wallet named `regtest_wallet` on first use. If you see errors:

```bash
# SSH into Umbrel and access Bitcoin CLI
docker exec -it bitcoin_bitcoind_1 bitcoin-cli -regtest createwallet "regtest_wallet"
```

### Cannot mine blocks

Make sure your Bitcoin node has a wallet loaded:

```bash
docker exec -it bitcoin_bitcoind_1 bitcoin-cli -regtest listwallets
```

### Permission denied errors

Ensure the app has proper permissions:

```bash
chmod -R 755 ~/umbrel/app-data/bitcoin-regtest-dashboard
```

## Development

To run the dashboard locally for development:

```bash
# Install dependencies
cd backend
npm install

# Set environment variables
export BITCOIN_RPC_HOST=localhost
export BITCOIN_RPC_PORT=18443
export BITCOIN_RPC_USER=your_user
export BITCOIN_RPC_PASS=your_pass

# Run the server
npm start
```

Then open `http://localhost:3000` in your browser.

## License

MIT License - Feel free to use, modify, and distribute.

## Contributing

Pull requests welcome! Please open an issue first to discuss major changes.
