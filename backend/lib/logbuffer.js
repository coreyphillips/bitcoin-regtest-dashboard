// Bounded in-memory ring buffers for the dashboard's own logs.
//
// Two buffers are kept: everything written to the console, and a structured
// record of every Bitcoin RPC call. The RPC one is the useful half when
// troubleshooting an integration, because it carries the method, duration and
// error rather than a truncated string.

const util = require('util');
const cfg = require('./config');

const MAX_MSG = 4096;

function makeRing(capacity) {
  const items = new Array(capacity);
  let writeIdx = 0;
  let nextSeq = 1;
  let dropped = 0;
  const subscribers = new Set();

  return {
    push(entry) {
      entry.seq = nextSeq++;
      if (items[writeIdx] !== undefined) dropped++;
      items[writeIdx] = entry;
      writeIdx = (writeIdx + 1) % capacity;
      for (const fn of subscribers) {
        // A broken subscriber must never break logging.
        try { fn(entry); } catch (e) { /* ignore */ }
      }
      return entry;
    },
    snapshot({ since = 0, limit = 200, filter = null, predicate = null } = {}) {
      const out = [];
      for (let i = 0; i < capacity; i++) {
        const entry = items[(writeIdx + i) % capacity];
        if (entry === undefined || entry.seq <= since) continue;
        if (predicate && !predicate(entry)) continue;
        if (filter && !filter(entry)) continue;
        out.push(entry);
      }
      return out.slice(-limit);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    stats() { return { capacity, dropped, nextSeq }; }
  };
}

const serverRing = makeRing(cfg.LOG_BUFFER_SIZE);
const rpcRing = makeRing(cfg.LOG_BUFFER_SIZE);

const ORIGINAL = {};
let patched = false;
let reentrant = false;

// Patch console so output lands in the ring buffer as well as stdout/stderr.
// The bound originals are always invoked FIRST and unconditionally, so Docker
// log collection is completely unaffected by anything below it.
function patchConsole() {
  if (patched) return;
  patched = true;

  for (const level of ['log', 'error', 'warn', 'info']) {
    ORIGINAL[level] = console[level].bind(console);
    console[level] = (...args) => {
      ORIGINAL[level](...args);
      if (reentrant) return;
      reentrant = true;
      try {
        let msg = util.format(...args);
        if (msg.length > MAX_MSG) msg = msg.slice(0, MAX_MSG) + ' ...[truncated]';
        serverRing.push({ ts: new Date().toISOString(), level, msg });
      } catch (e) {
        /* never let logging throw */
      } finally {
        reentrant = false;
      }
    };
  }

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });
}

function recordRpc(entry) {
  return rpcRing.push(Object.assign({ ts: new Date().toISOString() }, entry));
}

function note(text) {
  return serverRing.push({ ts: new Date().toISOString(), level: 'info', msg: text });
}

module.exports = {
  patchConsole,
  note,
  recordRpc,
  server: serverRing,
  rpc: rpcRing
};
