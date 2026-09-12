// Log access: bitcoind's debug.log, the dashboard's own console, and a
// structured record of every RPC call.

const express = require('express');
const fsp = require('fs').promises;

const cfg = require('../lib/config');
const logbuffer = require('../lib/logbuffer');
const { readTail, getTailer } = require('../lib/logtail');
const { openStream } = require('../lib/sse');
const { bitcoinRPC } = require('../lib/rpc');
const { HttpError, asyncHandler } = require('../lib/http');

const router = express.Router();

const MAX_LINES = 5000;
const MAX_BYTES = 8 * 1024 * 1024;

let openStreams = 0;

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// A filter is a plain case-insensitive substring, unless it is wrapped in
// slashes (/foo.*bar/) or ?regex=true is passed.
function makeMatcher(filter, useRegex) {
  if (!filter) return null;
  if (filter.length > 200) throw new HttpError(400, 'Filter is too long (max 200 characters)');

  const slashed = filter.length > 2 && filter.startsWith('/') && filter.endsWith('/');
  if (useRegex || slashed) {
    const pattern = slashed ? filter.slice(1, -1) : filter;
    try {
      const re = new RegExp(pattern, 'i');
      return (text) => re.test(text);
    } catch (e) {
      throw new HttpError(400, `Invalid regex: ${e.message}`);
    }
  }
  const needle = filter.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

function describeFileError(e, filePath) {
  if (e.code === 'ENOENT') {
    return new HttpError(404, `bitcoind debug.log not found at ${filePath}`, {
      hint: 'Set BITCOIN_DEBUG_LOG, or run via docker-compose where the bitcoin data volume is mounted read-only at /bitcoin/.bitcoin.',
      code: 'ENOENT'
    });
  }
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    return new HttpError(403, `debug.log at ${filePath} is not readable by the dashboard`, {
      hint: 'The dashboard container runs as uid 1000 and bitcoind writes debug.log mode 0600. The bundled docker-compose.yml chmods it to 644 in the bitcoin service permission loop.',
      code: e.code
    });
  }
  return new HttpError(500, `Could not read ${filePath}: ${e.message}`, { code: e.code });
}

// --- Discovery. This must never fail, so a client can always find out why a
// --- source is unavailable.
router.get('/logs/sources', asyncHandler(async (req, res) => {
  const bitcoind = { id: 'bitcoind', label: 'Bitcoin Core (debug.log)', path: cfg.BITCOIN_DEBUG_LOG, available: false };
  try {
    const stat = await fsp.stat(cfg.BITCOIN_DEBUG_LOG);
    await (await fsp.open(cfg.BITCOIN_DEBUG_LOG, 'r')).close();
    bitcoind.available = true;
    bitcoind.sizeBytes = stat.size;
    bitcoind.modified = stat.mtime.toISOString();
  } catch (e) {
    const described = describeFileError(e, cfg.BITCOIN_DEBUG_LOG);
    bitcoind.reason = e.code || 'ERROR';
    bitcoind.detail = described.message;
    bitcoind.hint = described.hint;
  }

  res.json({
    sources: [
      bitcoind,
      Object.assign({ id: 'server', label: 'Dashboard server', available: true }, logbuffer.server.stats()),
      Object.assign({ id: 'rpc', label: 'Bitcoin RPC calls', available: true }, logbuffer.rpc.stats())
    ],
    streaming: { endpoint: '/api/logs/stream', maxConcurrent: cfg.MAX_LOG_STREAMS, open: openStreams }
  });
}));

// --- bitcoind debug.log
router.get('/logs/bitcoind', asyncHandler(async (req, res) => {
  const lines = clampInt(req.query.lines, 200, 1, MAX_LINES);
  const maxBytes = clampInt(req.query.maxBytes, 256 * 1024, 1024, MAX_BYTES);
  const match = makeMatcher(req.query.filter, req.query.regex === 'true');

  let tail;
  try {
    tail = await readTail(cfg.BITCOIN_DEBUG_LOG, { maxBytes, maxLines: lines });
  } catch (e) {
    throw describeFileError(e, cfg.BITCOIN_DEBUG_LOG);
  }

  const matched = match ? tail.lines.filter(match) : tail.lines;
  res.json({
    source: 'bitcoind',
    path: cfg.BITCOIN_DEBUG_LOG,
    lines: matched.slice(-lines),
    returned: Math.min(matched.length, lines),
    matched: matched.length,
    // scannedLines and truncatedHead tell the caller that a filter searched only
    // the tail window, not the whole file. This is the most confusing part of
    // combining tail with filter, so it is reported rather than left implicit.
    scannedLines: tail.scannedLines,
    truncatedHead: tail.truncatedHead,
    sizeBytes: tail.size,
    offset: tail.offset,
    windowBytes: maxBytes
  });
}));

// --- The dashboard's own console output
router.get('/logs/server', asyncHandler(async (req, res) => {
  const limit = clampInt(req.query.limit || req.query.lines, 200, 1, MAX_LINES);
  const since = clampInt(req.query.since, 0, 0, Number.MAX_SAFE_INTEGER);
  const level = req.query.level;
  const match = makeMatcher(req.query.filter, req.query.regex === 'true');

  const entries = logbuffer.server.snapshot({
    since,
    limit,
    predicate: level ? (e) => e.level === level : null,
    filter: match ? (e) => match(e.msg) : null
  });

  res.json({ source: 'server', entries, returned: entries.length, buffer: logbuffer.server.stats() });
}));

// --- Structured RPC call log
router.get('/logs/rpc', asyncHandler(async (req, res) => {
  const limit = clampInt(req.query.limit || req.query.lines, 100, 1, MAX_LINES);
  const since = clampInt(req.query.since, 0, 0, Number.MAX_SAFE_INTEGER);
  const method = req.query.method;
  const errorsOnly = req.query.errorsOnly === 'true';

  const entries = logbuffer.rpc.snapshot({
    since,
    limit,
    predicate: (e) => {
      if (errorsOnly && e.ok) return false;
      if (method && e.method !== method) return false;
      return true;
    }
  });

  res.json({ source: 'rpc', entries, returned: entries.length, buffer: logbuffer.rpc.stats() });
}));

// --- Follow mode over SSE. Clients that cannot use SSE should poll the
// --- endpoints above with ?since= or ?after= instead.
router.get('/logs/stream', asyncHandler(async (req, res) => {
  const source = ['bitcoind', 'server', 'all'].includes(req.query.source) ? req.query.source : 'bitcoind';
  const backfill = clampInt(req.query.lines, 200, 0, 2000);

  if (openStreams >= cfg.MAX_LOG_STREAMS) {
    throw new HttpError(503, 'Too many concurrent log streams', { limit: cfg.MAX_LOG_STREAMS });
  }

  const wantsBitcoind = source === 'bitcoind' || source === 'all';
  const wantsServer = source === 'server' || source === 'all';

  // Fail before opening the stream so the client gets a real status code.
  if (wantsBitcoind && source === 'bitcoind') {
    try {
      await (await fsp.open(cfg.BITCOIN_DEBUG_LOG, 'r')).close();
    } catch (e) {
      throw describeFileError(e, cfg.BITCOIN_DEBUG_LOG);
    }
  }

  openStreams++;
  const stream = openStream(req, res);
  stream.onClose(() => { openStreams--; });

  if (wantsBitcoind && backfill > 0) {
    try {
      const tail = await readTail(cfg.BITCOIN_DEBUG_LOG, { maxBytes: 256 * 1024, maxLines: backfill });
      for (const text of tail.lines.slice(-backfill)) {
        stream.send('line', { source: 'bitcoind', text });
      }
    } catch (e) {
      stream.send('error', { source: 'bitcoind', message: e.message, code: e.code });
    }
  }

  if (wantsServer && backfill > 0) {
    for (const entry of logbuffer.server.snapshot({ limit: backfill })) {
      stream.send('line', { source: 'server', text: `[${entry.ts}] ${entry.msg}`, level: entry.level });
    }
  }

  stream.send('ready', { source, backfill });

  if (wantsBitcoind) {
    const tailer = getTailer(cfg.BITCOIN_DEBUG_LOG);
    stream.onClose(tailer.subscribe((event) => {
      if (stream.closed) return;
      if (event.type === 'line') stream.send('line', { source: 'bitcoind', text: event.text }, event.offset);
      else if (event.type === 'rotated') stream.send('rotated', { source: 'bitcoind', reason: event.reason });
      else if (event.type === 'error') stream.send('error', { source: 'bitcoind', message: event.message, code: event.code });
    }));
  }

  if (wantsServer) {
    stream.onClose(logbuffer.server.subscribe((entry) => {
      if (stream.closed) return;
      stream.send('line', { source: 'server', text: `[${entry.ts}] ${entry.msg}`, level: entry.level }, entry.seq);
    }));
  }
}));

// --- bitcoind logging categories, so a category can be turned on before
// --- reproducing a bug without restarting the node.
router.get('/logs/debug-categories', asyncHandler(async (req, res) => {
  const categories = await bitcoinRPC('logging');
  res.json({
    categories,
    enabled: Object.keys(categories).filter((k) => categories[k]),
    note: 'Changes are runtime only and reset when bitcoind restarts.'
  });
}));

router.post('/logs/debug-categories', asyncHandler(async (req, res) => {
  const { include = [], exclude = [] } = req.body || {};
  if (!Array.isArray(include) || !Array.isArray(exclude)) {
    throw new HttpError(400, 'include and exclude must be arrays of category names');
  }

  // Validate against the node's own list so the caller gets a useful message
  // rather than bitcoind's bare "unsupported logging category" error.
  const current = await bitcoinRPC('logging');
  const valid = new Set(Object.keys(current).concat(['all', 'none']));
  const unknown = include.concat(exclude).filter((c) => !valid.has(c));
  if (unknown.length) {
    throw new HttpError(400, `Unknown logging categories: ${unknown.join(', ')}`, {
      details: { validCategories: Object.keys(current).sort() }
    });
  }

  const categories = await bitcoinRPC('logging', [include, exclude]);
  res.json({
    categories,
    enabled: Object.keys(categories).filter((k) => categories[k]),
    note: 'Changes are runtime only and reset when bitcoind restarts.'
  });
}));

module.exports = router;
