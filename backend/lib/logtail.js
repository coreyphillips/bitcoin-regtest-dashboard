// Reading bitcoind's debug.log without pulling the whole file into memory.

const fsp = require('fs').promises;

const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Read the tail of a file. Never loads more than maxBytes.
 * Returns the parsed lines plus enough metadata for the caller to understand
 * that a filter only searched the tail window, not the entire file.
 */
async function readTail(filePath, { maxBytes = DEFAULT_MAX_BYTES, maxLines = 200 } = {}) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len === 0) {
      return { lines: [], size, offset: size, truncatedHead: false, scannedLines: 0 };
    }
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, start);

    let text = buf.toString('utf8');
    const truncatedHead = start > 0;
    if (truncatedHead) {
      // The first line is almost certainly cut in half; drop it.
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    if (text.endsWith('\n')) text = text.slice(0, -1);
    const all = text === '' ? [] : text.split('\n');

    return { lines: all, size, offset: size, truncatedHead, scannedLines: all.length, maxLines };
  } finally {
    await fh.close();
  }
}

/**
 * Read bytes from `offset` onward, for incremental polling and follow mode.
 * Detects both truncation (size shrank) and replacement (new inode).
 */
async function readSince(filePath, offset, { maxBytes = 1024 * 1024 } = {}) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const size = stat.size;
    const ino = stat.ino;

    if (size < offset) {
      return { rotated: true, reason: 'truncated', chunk: '', offset: 0, size, ino };
    }
    if (size === offset) {
      return { rotated: false, chunk: '', offset, size, ino };
    }

    // If we have fallen a long way behind, skip forward rather than allocating.
    const start = size - offset > maxBytes ? size - maxBytes : offset;
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, start);

    return {
      rotated: false,
      skipped: start > offset,
      chunk: buf.toString('utf8'),
      offset: start + len,
      size,
      ino
    };
  } finally {
    await fh.close();
  }
}

/**
 * A single poller shared by every follower of a given file, so N SSE clients
 * cost one stat and one read per tick rather than N.
 *
 * fs.stat polling is used rather than fs.watch on purpose: fs.watch keeps
 * watching the old inode across a rotation and its reliability varies across
 * Docker storage drivers for mounted volumes.
 */
class FileTailer {
  constructor(filePath, { intervalMs = 700, maxPartial = 1024 * 1024 } = {}) {
    this.path = filePath;
    this.intervalMs = intervalMs;
    this.maxPartial = maxPartial;
    this.subs = new Set();
    this.timer = null;
    this.busy = false;
    this.partial = '';
    this.offset = null;
    this.ino = undefined;
    this.errored = false;
  }

  subscribe(fn) {
    this.subs.add(fn);
    if (this.subs.size === 1) this.start();
    return () => {
      this.subs.delete(fn);
      if (this.subs.size === 0) this.stop();
    };
  }

  get followerCount() { return this.subs.size; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.partial = '';
    this.offset = null;
    this.ino = undefined;
    this.errored = false;
  }

  _emit(event) {
    for (const fn of this.subs) {
      try { fn(event); } catch (e) { /* a broken subscriber must not stop the tail */ }
    }
  }

  async _tick() {
    if (this.busy) return; // never let reads overlap
    this.busy = true;
    try {
      if (this.offset === null) {
        const stat = await fsp.stat(this.path);
        this.offset = stat.size;
        this.ino = stat.ino;
      }

      const r = await readSince(this.path, this.offset);

      if (this.ino !== undefined && r.ino !== this.ino) {
        this._emit({ type: 'rotated', reason: 'new file' });
        this.offset = 0;
        this.partial = '';
      } else if (r.rotated) {
        this._emit({ type: 'rotated', reason: r.reason });
        this.offset = 0;
        this.partial = '';
      }
      this.ino = r.ino;

      if (r.chunk) {
        const text = this.partial + r.chunk;
        const parts = text.split('\n');
        this.partial = parts.pop();
        if (this.partial.length > this.maxPartial) this.partial = '';
        this.offset = r.offset;
        for (const line of parts) {
          if (line) this._emit({ type: 'line', text: line, offset: this.offset });
        }
      }
      this.errored = false;
    } catch (e) {
      // Report once per error episode rather than every tick.
      if (!this.errored) {
        this.errored = true;
        this._emit({ type: 'error', message: e.message, code: e.code });
      }
    } finally {
      this.busy = false;
    }
  }
}

const tailers = new Map();
function getTailer(filePath) {
  if (!tailers.has(filePath)) tailers.set(filePath, new FileTailer(filePath));
  return tailers.get(filePath);
}

module.exports = { readTail, readSince, FileTailer, getTailer };
