// Server-sent events helper.
//
// Umbrel fronts apps with a reverse proxy, so the headers below matter: without
// X-Accel-Buffering and no-transform the stream can be buffered into
// uselessness. Clients should still be able to fall back to polling.

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);
  res.write(': connected\n\n'); // flush immediately so onopen fires through proxies

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* closing */ }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  const cleanups = [() => clearInterval(heartbeat)];
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanups) {
      try { fn(); } catch (e) { /* ignore */ }
    }
    try { res.end(); } catch (e) { /* ignore */ }
  };

  res.on('close', close);
  res.on('error', close);
  req.on('aborted', close);

  return {
    send(event, data, id) {
      if (closed || res.writableEnded) return;
      try {
        if (id !== undefined) res.write(`id: ${id}\n`);
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        close();
      }
    },
    onClose(fn) { cleanups.push(fn); },
    close,
    get closed() { return closed; }
  };
}

module.exports = { openStream };
