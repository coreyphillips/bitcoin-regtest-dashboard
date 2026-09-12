#!/usr/bin/env node
// Fails when the routes Express actually registered and the catalogue in
// lib/operations.js disagree. This is what stops the docs drifting: the README
// has previously documented endpoints that were never implemented.
//
// Requires server.js NOT to call listen() on import, which is why it has the
// `if (require.main === module)` guard.

const app = require('../server');
const OPERATIONS = require('../lib/operations');

// Walk the Express router tree, tracking the prefix each sub-router is mounted
// under, and collect every concrete "METHOD /path" it can serve.
function collectRoutes(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        out.add(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      collectRoutes(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
  return out;
}

// Express stores the mount path as a regexp; recover the literal prefix.
// The source looks like ^\/api\/?(?=\/|$), so take the literal run after the
// leading escaped slash and drop the trailing optional-slash marker.
function mountPath(layer) {
  if (!layer.regexp) return '';
  const source = layer.regexp.source;
  if (source === '^\\/?(?=\\/|$)') return '';
  const match = source.match(/^\^\\\/([^\\]*)/);
  if (!match || !match[1]) return '';
  return '/' + match[1];
}

// A router mounted at /api whose own path is '/' serves /api, not /api/.
function normalize(route) {
  const [method, path] = route.split(' ');
  const cleaned = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return `${method} ${cleaned}`;
}

const router = app._router || app.router;
if (!router) {
  console.error('Could not reach the Express router. Express version change?');
  process.exit(1);
}

const actual = collectRoutes(router.stack, '', new Set());
actual.delete('GET *'); // the SPA catch-all is not an API endpoint

const normalized = new Set([...actual].map(normalize));

const documented = new Set(OPERATIONS.map((o) => `${o.method.toUpperCase()} ${o.path}`));

const undocumented = [...normalized].filter((r) => !documented.has(r)).sort();
const phantom = [...documented].filter((r) => !normalized.has(r)).sort();

if (undocumented.length) {
  console.error(`\nRoutes with no entry in lib/operations.js (${undocumented.length}):`);
  for (const r of undocumented) console.error('  ' + r);
}
if (phantom.length) {
  console.error(`\nDocumented endpoints that no route serves (${phantom.length}):`);
  for (const r of phantom) console.error('  ' + r);
}

if (undocumented.length || phantom.length) {
  console.error('\nUpdate backend/lib/operations.js so it matches the routes.');
  process.exit(1);
}

// Registration order matters as much as registration: a route registered after
// a wildcard that matches it is documented but unreachable. This catches the
// /api/block/best vs /api/block/:hash class of bug.
const ordered = [...collectRoutes(router.stack, '', new Set())].map(normalize);
const shadowed = [];
for (let i = 0; i < ordered.length; i++) {
  const [methodA, pathA] = ordered[i].split(' ');
  if (!pathA.includes(':')) continue;
  const pattern = new RegExp('^' + pathA.replace(/:[^/]+/g, '[^/]+') + '$');
  for (let j = i + 1; j < ordered.length; j++) {
    const [methodB, pathB] = ordered[j].split(' ');
    if (methodA !== methodB || pathB.includes(':')) continue;
    if (pattern.test(pathB)) shadowed.push(`${ordered[j]} is unreachable, shadowed by ${ordered[i]}`);
  }
}
if (shadowed.length) {
  console.error('\nUnreachable routes (registered after a wildcard that matches them):');
  for (const s of shadowed) console.error('  ' + s);
  process.exit(1);
}

console.log(`OK: ${normalized.size} routes registered, all documented, none shadowed.`);
