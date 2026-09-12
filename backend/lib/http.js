// Shared HTTP plumbing for the newer routes.
//
// The pre-existing routes keep their own inline try/catch and are untouched by
// this, so their response shapes stay byte-identical.

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    Object.assign(this, extra);
  }
}

// Express 4 does not catch rejected promises from async handlers. Without this
// wrapper an unhandled rejection leaves the request hanging forever.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Bitcoin Core JSON-RPC error codes worth mapping to something better than 500.
const RPC_STATUS = {
  '-1': 400,    // misc / wrong argument type
  '-3': 400,    // unexpected type
  '-5': 400,    // invalid address or key
  '-6': 400,    // insufficient funds
  '-8': 400,    // invalid parameter
  '-18': 503,   // wallet not found
  '-25': 400,   // transaction rejected
  '-26': 400,   // transaction rejected by mempool
  '-28': 503,   // still starting up
  '-32601': 404 // method not found
};

function errorHandler(err, req, res, next) {
  // Once SSE headers are out there is nothing useful we can write.
  if (res.headersSent) return next(err);

  const status = err.status || RPC_STATUS[String(err.rpcCode)] || 500;
  const body = { error: err.message || 'Internal error' };
  if (err.rpcCode !== undefined) body.rpcCode = err.rpcCode;
  if (err.hint) body.hint = err.hint;
  if (err.details) body.details = err.details;

  if (status >= 500) console.error(`${req.method} ${req.originalUrl} failed: ${err.stack || err.message}`);
  res.status(status).json(body);
}

// Without this, an unknown /api path falls through to the SPA catch-all and
// returns HTTP 200 with the dashboard HTML, so every client's response.json()
// throws an opaque SyntaxError instead of reporting a bad path.
function apiNotFound(req, res) {
  res.status(404).json({
    error: 'Unknown API endpoint',
    method: req.method,
    path: req.originalUrl,
    hint: 'GET /api for the endpoint index, or GET /api/openapi.json for the full spec'
  });
}

module.exports = { HttpError, asyncHandler, errorHandler, apiNotFound };
