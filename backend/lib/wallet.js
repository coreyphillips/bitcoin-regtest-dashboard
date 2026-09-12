// Wallet bootstrapping.

const { bitcoinRPC } = require('./rpc');
const cfg = require('./config');

async function ensureWalletLoaded() {
  const loaded = await bitcoinRPC('listwallets', [], false, { quiet: true });
  if (loaded.includes(cfg.RPC_WALLET)) return true;
  try {
    await bitcoinRPC('loadwallet', [cfg.RPC_WALLET]);
  } catch (e) {
    await bitcoinRPC('createwallet', [cfg.RPC_WALLET]);
  }
  return true;
}

// Bitcoin Core may take a while to accept RPC after the container starts.
async function initializeWallet() {
  const maxRetries = 30;
  const retryDelay = 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Wallet initialization attempt ${attempt}/${maxRetries}...`);

      const loadedWallets = await bitcoinRPC('listwallets');
      if (loadedWallets.includes(cfg.RPC_WALLET)) {
        console.log(`Wallet '${cfg.RPC_WALLET}' is already loaded.`);
        return true;
      }

      try {
        await bitcoinRPC('loadwallet', [cfg.RPC_WALLET]);
        console.log(`Wallet '${cfg.RPC_WALLET}' loaded successfully.`);
        return true;
      } catch (loadError) {
        if (loadError.message.includes('not found') || loadError.message.includes('does not exist')) {
          console.log(`Wallet '${cfg.RPC_WALLET}' not found, creating...`);
          await bitcoinRPC('createwallet', [cfg.RPC_WALLET]);
          console.log(`Wallet '${cfg.RPC_WALLET}' created successfully.`);
          return true;
        }
        throw loadError;
      }
    } catch (error) {
      console.log(`Wallet initialization failed: ${error.message}`);
      if (attempt < maxRetries) {
        console.log(`Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  console.error(`Failed to initialize wallet after ${maxRetries} attempts.`);
  return false;
}

module.exports = { initializeWallet, ensureWalletLoaded };
