// Mining helpers and the auto-mine job.
//
// The auto-mine job is a single server-side interval, independent of any
// browser tab, so mining continues when the dashboard is closed.

const { bitcoinRPC } = require('./rpc');
const cfg = require('./config');

// Resolve a usable mining address: use the one provided, otherwise a fresh
// wallet address, creating or loading the wallet if it is missing.
async function resolveMiningAddress(address) {
  if (address) return address;

  try {
    return await bitcoinRPC('getnewaddress', ['mining', 'bech32'], true);
  } catch (e) {
    if (e.message.includes('wallet')) {
      try {
        await bitcoinRPC('createwallet', [cfg.RPC_WALLET]);
        return await bitcoinRPC('getnewaddress', ['mining', 'bech32'], true);
      } catch (walletError) {
        try {
          await bitcoinRPC('loadwallet', [cfg.RPC_WALLET]);
          return await bitcoinRPC('getnewaddress', ['mining', 'bech32'], true);
        } catch (loadError) {
          throw new Error('Could not create or load wallet: ' + loadError.message);
        }
      }
    }
    throw e;
  }
}

let autoMineJob = null;

function isAutoMineRunning() { return autoMineJob !== null; }

function autoMineStatus() {
  if (!autoMineJob) return { running: false };
  const indefinite = !autoMineJob.endsAt;
  return {
    running: true,
    blocksMined: autoMineJob.blocksMined,
    indefinite: indefinite,
    remainingSeconds: indefinite ? null : Math.max(0, Math.round((autoMineJob.endsAt - Date.now()) / 1000)),
    intervalSeconds: autoMineJob.intervalSeconds,
    blocksPerTick: autoMineJob.blocksPerTick,
    address: autoMineJob.address,
    startedAt: autoMineJob.startedAt,
    lastError: autoMineJob.lastError || null
  };
}

function stopAutoMine() {
  if (autoMineJob) {
    if (autoMineJob.timer) clearInterval(autoMineJob.timer);
    if (autoMineJob.stopTimer) clearTimeout(autoMineJob.stopTimer);
  }
  autoMineJob = null;
}

async function autoMineTick() {
  const job = autoMineJob;
  if (!job) return;

  // Stop cleanly once the deadline has passed (only when a duration is set)
  if (job.endsAt && Date.now() >= job.endsAt) {
    stopAutoMine();
    return;
  }

  // Skip if the previous tick is still mining (can happen with large batches)
  if (job.ticking) return;
  job.ticking = true;
  try {
    const hashes = await bitcoinRPC('generatetoaddress', [job.blocksPerTick, job.address]);
    job.blocksMined += Array.isArray(hashes) ? hashes.length : 0;
    job.lastError = null;
  } catch (e) {
    job.lastError = e.message;
    console.error(`Auto-mine tick error: ${e.message}`);
  } finally {
    if (autoMineJob === job) job.ticking = false;
  }
}

async function startAutoMine({ durationMinutes, intervalSeconds, blocksPerTick, address }) {
  const miningAddress = await resolveMiningAddress(address);
  const now = Date.now();
  const endsAt = durationMinutes ? now + durationMinutes * 60000 : null;

  autoMineJob = {
    timer: null,
    stopTimer: null,
    startedAt: now,
    endsAt: endsAt,
    intervalSeconds: intervalSeconds,
    blocksPerTick: blocksPerTick,
    address: miningAddress,
    blocksMined: 0,
    ticking: false,
    lastError: null
  };
  console.log(`Auto-mine started: ${durationMinutes ? durationMinutes + 'm' : 'until stopped'}, every ${intervalSeconds}s, ${blocksPerTick} block(s)/tick to ${miningAddress}`);

  // Mine one batch immediately for instant feedback, then on the interval
  await autoMineTick();
  if (autoMineJob) {
    autoMineJob.timer = setInterval(autoMineTick, intervalSeconds * 1000);
    if (endsAt) {
      autoMineJob.stopTimer = setTimeout(() => {
        console.log(`Auto-mine finished: ${autoMineJob ? autoMineJob.blocksMined : 0} block(s) mined`);
        stopAutoMine();
      }, endsAt - Date.now());
    }
  }
  return autoMineStatus();
}

module.exports = {
  resolveMiningAddress,
  autoMineStatus,
  stopAutoMine,
  startAutoMine,
  isAutoMineRunning,
  blocksMined: () => (autoMineJob ? autoMineJob.blocksMined : 0)
};
