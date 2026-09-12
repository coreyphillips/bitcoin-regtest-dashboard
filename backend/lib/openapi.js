// Builds an OpenAPI 3.1 document, the /api index, and the llms.txt cheat sheet
// from lib/operations.js, so all three stay consistent by construction.

const OPERATIONS = require('./operations');
const pkg = require('../package.json');

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string', description: 'Human readable failure message' },
    rpcCode: { type: 'integer', description: 'Bitcoin Core JSON-RPC error code, when the failure came from the node' },
    hint: { type: 'string', description: 'How to fix it' },
    details: { type: 'object', description: 'Extra context' }
  }
};

// Express uses :param, OpenAPI uses {param}.
function toOpenApiPath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParamNames(path) {
  return (path.match(/:([A-Za-z0-9_]+)/g) || []).map((s) => s.slice(1));
}

function buildOperation(op, authRequired) {
  const parameters = [];

  for (const name of pathParamNames(op.path)) {
    const declared = (op.params || {})[name];
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: declared ? { type: declared.type } : { type: 'string' },
      description: declared ? declared.description : undefined
    });
  }

  for (const [name, schema] of Object.entries(op.query || {})) {
    const { description, ...rest } = schema;
    parameters.push({ name, in: 'query', required: false, schema: rest, description });
  }

  const responses = {
    200: {
      description: 'Success',
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    400: { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    500: { description: 'Server or node error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  };
  if (authRequired && !op.open) {
    responses[401] = { description: 'API token required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  }

  const operation = {
    operationId: op.id,
    tags: [op.tag],
    summary: op.summary,
    responses
  };

  const description = [op.description, op.deprecationNote].filter(Boolean).join('\n\n');
  if (description) operation.description = description;
  if (op.deprecated) operation.deprecated = true;
  if (parameters.length) operation.parameters = parameters;
  if (op.curl) operation['x-curl'] = op.curl;
  // A spec that claims auth on an endpoint that does not need it is worse than
  // no spec, so the discovery endpoints opt out explicitly.
  if (authRequired && op.open) operation.security = [];
  if (op.body) {
    operation.requestBody = {
      required: !!(op.body.required && op.body.required.length),
      content: { 'application/json': { schema: op.body } }
    };
  }

  return operation;
}

function buildSpec({ baseUrl, authRequired }) {
  const paths = {};
  for (const op of OPERATIONS) {
    const key = toOpenApiPath(op.path);
    paths[key] = paths[key] || {};
    paths[key][op.method] = buildOperation(op, authRequired);
  }

  const spec = {
    openapi: '3.1.1',
    info: {
      title: 'Bitcoin Regtest Dashboard API',
      version: pkg.version,
      description: 'Local control API for a Bitcoin regtest network. Mine blocks, fund addresses, drive reorgs, inspect blocks, transactions and the mempool, and read Bitcoin Core logs. Intended for driving a disposable regtest node from a test suite or an agent.',
      license: { name: 'MIT', identifier: 'MIT' }
    },
    servers: [{ url: baseUrl }],
    tags: [...new Set(OPERATIONS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
    components: {
      schemas: { Error: ERROR_SCHEMA },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Set API_TOKEN on the server to enable. Unset means the API is open.'
        }
      }
    }
  };

  if (authRequired) spec.security = [{ bearerAuth: [] }];
  return spec;
}

function buildIndex({ baseUrl, auth, chain, endpointCount }) {
  const groups = {};
  for (const op of OPERATIONS) {
    groups[op.tag] = groups[op.tag] || [];
    groups[op.tag].push(`${op.method.toUpperCase()} ${op.path}${op.deprecated ? ' (deprecated)' : ''}`);
  }

  return {
    name: 'Bitcoin Regtest Dashboard API',
    version: pkg.version,
    network: chain,
    openapi: `${baseUrl}/api/openapi.json`,
    llmsTxt: `${baseUrl}/api/llms.txt`,
    connection: `${baseUrl}/api/connection`,
    status: `${baseUrl}/api/status`,
    auth,
    endpointCount: endpointCount || OPERATIONS.length,
    groups,
    quickstart: [
      `curl -s ${baseUrl}/api/status`,
      `curl -sX POST ${baseUrl}/api/faucet -H 'Content-Type: application/json' -d '{"address":"bcrt1...","amount":1}'`,
      `curl -sX POST ${baseUrl}/api/mine -H 'Content-Type: application/json' -d '{"blocks":1}'`,
      `curl -s "${baseUrl}/api/logs/bitcoind?lines=50"`
    ],
    docs: 'https://github.com/coreyphillips/bitcoin-regtest-dashboard/blob/main/API.md'
  };
}

// A compact reference an agent can absorb in one cheap fetch, instead of
// parsing 60 KB of OpenAPI JSON.
function buildLlmsTxt({ baseUrl, authRequired }) {
  const lines = [];
  lines.push('# Bitcoin Regtest Dashboard API');
  lines.push('');
  lines.push(`Base URL: ${baseUrl}`);
  lines.push(`Version: ${pkg.version}`);
  lines.push(`Auth: ${authRequired ? 'required, send "Authorization: Bearer <API_TOKEN>" (SSE uses ?access_token=)' : 'none'}`);
  lines.push('All responses are JSON. Errors are {"error": "...", "rpcCode"?, "hint"?} with a 4xx or 5xx status.');
  lines.push('OpenAPI spec: /api/openapi.json');
  lines.push('');
  lines.push('## Notes that save time');
  lines.push('- Regtest coinbase needs 100 confirmations to mature, so POST /api/faucet mines for you when the wallet is empty.');
  lines.push('- The wait endpoints answer 200 whether or not the condition was met. Check "satisfied" and "timedOut".');
  lines.push('- POST /api/chain/reorg with includeMempool=false mines EMPTY blocks. That is the only way disconnected transactions stay unconfirmed.');
  lines.push("- bitcoind's RPC port is not published to the host. Use POST /api/rpc to reach any RPC method.");
  lines.push('- Log filters search only the tail window that was read; the response reports scannedLines and truncatedHead.');
  lines.push('');

  const byTag = {};
  for (const op of OPERATIONS) {
    byTag[op.tag] = byTag[op.tag] || [];
    byTag[op.tag].push(op);
  }

  for (const [tag, ops] of Object.entries(byTag)) {
    lines.push(`## ${tag}`);
    for (const op of ops) {
      const flag = op.deprecated ? ' [DEPRECATED]' : '';
      lines.push(`${op.method.toUpperCase()} ${op.path}${flag} - ${op.summary}`);
      if (op.body && op.body.properties) {
        const fields = Object.entries(op.body.properties).map(([name, s]) => {
          const req = (op.body.required || []).includes(name) ? '*' : '';
          const def = s.default !== undefined ? `=${JSON.stringify(s.default)}` : '';
          return `${name}${req}:${s.type}${def}`;
        });
        lines.push(`    body: {${fields.join(', ')}}`);
      }
      if (op.query) {
        const fields = Object.entries(op.query).map(([name, s]) => {
          const def = s.default !== undefined ? `=${JSON.stringify(s.default)}` : '';
          return `${name}:${s.type}${def}`;
        });
        lines.push(`    query: ${fields.join(', ')}`);
      }
    }
    lines.push('');
  }

  lines.push('(* marks a required field)');
  return lines.join('\n');
}

module.exports = { buildSpec, buildIndex, buildLlmsTxt, OPERATIONS, toOpenApiPath };
