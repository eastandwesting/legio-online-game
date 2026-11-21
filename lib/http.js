// Static files and the health check for the public edge. Every request target
// is hostile input: nothing here may throw, and no stream error may escape.
// The public files are read once, at start-up, and served from memory with a strong ETag (an unknown
// path is a Map miss: a request costs no file-system call). Requests are limited per client address.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { clientIp, proxyHops, createKeyedBuckets } from './limits.js';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-cache',
};

const TEXT = 'text/plain; charset=utf-8';
const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const MIME = {
  '.html': HTML,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': TEXT,
  '.json': JSON_TYPE,
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_TARGET = 2048;            // characters of request target we look at
const MAX_FILE = 8 * 1024 * 1024;   // files are sent from memory; refuse absurd ones
const MAX_CACHE = 64 * 1024 * 1024; // all cached files together
const MAX_DEPTH = 8;                // directory levels the start-up scan descends

// One path segment: plain ASCII, no leading dot (dotfiles, '.', '..'), no
// trailing dot, and none of the characters an OS treats specially (':' '~' ...).
const SEGMENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;

// fs errors that simply mean "there is no such public file".
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'EACCES', 'EPERM', 'ELOOP', 'EINVAL']);

const noop = () => {};

function reply(req, res, status, type, body, extra) {
  try {
    if (res.headersSent || res.destroyed) return; // client went away, or already answered
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, { ...SECURITY_HEADERS, ...extra, 'Content-Type': type, 'Content-Length': buf.length });
    if (req.method === 'HEAD') res.end();
    else res.end(buf);
  } catch {
    try { res.destroy(); } catch { /* nothing left to do */ }
  }
}

const badRequest = (req, res) => reply(req, res, 400, TEXT, 'Bad request');
const notFound = (req, res) => reply(req, res, 404, TEXT, 'Not found');

function health(req, res, query, getStats) {
  if (typeof getStats === 'function' && /(?:^|&)stats(?:=|&|$)/.test(query)) {
    try {
      const json = JSON.stringify(getStats());
      if (typeof json === 'string') return reply(req, res, 200, JSON_TYPE, json);
    } catch { /* a broken stats callback must not fail the health check */ }
  }
  reply(req, res, 200, TEXT, 'ok');
}

// dir + separator, also correct when dir is a filesystem root ('/' or 'C:\').
const withSep = dir => (dir.endsWith(path.sep) ? dir : dir + path.sep);

// Resolves to the file's bytes, or null when the request must not be served.
async function readPublicFile(root, segments) {
  const rest = segments.join(path.sep);
  const file = path.join(root, rest);
  if (file !== withSep(root) + rest) return null;
  // The real path must be the same file under the real root. This refuses
  // symlinks or junctions that leave the root, and OS aliases of a public file
  // (other letter case, 8.3 short names, NTFS streams, device names).
  const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  if (real !== withSep(realRoot) + rest) return null;
  const handle = await fs.open(real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE) return null;
    return await handle.readFile();
  } finally {
    await handle.close().catch(noop);
  }
}

const htmlHeaders = type => (type === HTML ? { 'Content-Security-Policy': CSP } : undefined);
const typeOf = name => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

// Without the cache (cacheStatic: false): read the file on every request.
async function serveFile(req, res, root, segments) {
  let body = null;
  try {
    body = await readPublicFile(root, segments);
  } catch (err) {
    if (!MISSING.has(err?.code)) return reply(req, res, 500, TEXT, 'Server error');
  }
  if (!body) return notFound(req, res);
  const type = typeOf(segments[segments.length - 1]);
  reply(req, res, 200, type, body, htmlHeaders(type));
}

// Every servable file under root, read once: 'sub/file.txt' -> { body, type, etag, headers }. Same rules as
// the per-request path: only names that pass SEGMENT (so no dot-files or dot-directories), regular files
// only (a symlink or junction is skipped, so nothing outside the root is ever reachable), nothing huge.
function buildCache(root) {
  const files = new Map();
  let total = 0;
  const walk = (dir, prefix, depth) => {
    let entries;
    try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const name = entry.name;
      if (!SEGMENT.test(name)) continue;
      const full = path.join(dir, name);
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) walk(full, prefix + name + '/', depth + 1); continue; }
      if (!entry.isFile()) continue;
      try {
        const stat = fsSync.statSync(full);
        if (!stat.isFile() || stat.size > MAX_FILE || total + stat.size > MAX_CACHE) continue;
        const body = fsSync.readFileSync(full);
        total += body.length;
        const type = typeOf(name);
        const etag = '"' + crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27) + '"';
        files.set(prefix + name, { body, type, etag, headers: { ...htmlHeaders(type), ETag: etag } });
      } catch { /* unreadable: simply not served */ }
    }
  };
  walk(root, '', 0);
  return files;
}

// If-None-Match: '*', or a list of entity tags; weak comparison, as GET asks for.
function etagMatches(header, etag) {
  if (typeof header !== 'string') return false;
  if (header.trim() === '*') return true;
  return header.split(',').some(part => { const t = part.trim(); return t === etag || t === 'W/' + etag; });
}

function serveCached(req, res, entry) {
  if (etagMatches(req.headers?.['if-none-match'], entry.etag)) {
    try {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(304, { ...SECURITY_HEADERS, ...entry.headers });
      res.end();
    } catch {
      try { res.destroy(); } catch { /* nothing left to do */ }
    }
    return;
  }
  reply(req, res, 200, entry.type, entry.body, entry.headers);
}

function route(req, res, ctx) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return reply(req, res, 405, TEXT, 'Method not allowed', { Allow: 'GET, HEAD' });
  }
  const target = req.url;
  // Origin-form only: absolute-form ('http://host/x') and '*' are refused here.
  if (typeof target !== 'string' || target[0] !== '/') return badRequest(req, res);
  if (target.length > MAX_TARGET) return reply(req, res, 414, TEXT, 'URI too long');

  const q = target.indexOf('?');
  const query = q < 0 ? '' : target.slice(q + 1);
  let pathname;
  try {
    pathname = decodeURIComponent(q < 0 ? target : target.slice(0, q));
  } catch {
    return badRequest(req, res);
  }
  // Checked after decoding, so '%00' and '%5c' are caught as well. The path is
  // decoded exactly once and only the decoded form is ever used below.
  if (pathname.includes('\0') || pathname.includes('\\')) return badRequest(req, res);

  if (pathname === '/healthz') return health(req, res, query, ctx.getStats); // never touches the disk
  if (pathname === '/') pathname = '/index.html';

  // Empty segments ('//', trailing '/') are refused too: no directory indexes.
  const segments = pathname.slice(1).split('/');
  if (!segments.every(s => SEGMENT.test(s))) return notFound(req, res);
  if (!ctx.cache) return serveFile(req, res, ctx.root, segments);
  const entry = ctx.cache.get(segments.join('/'));
  return entry ? serveCached(req, res, entry) : notFound(req, res);
}

// The health check is exempt from the request limit (a platform probes it, and it is the cheapest request).
const isHealthCheck = req => (req.method === 'GET' || req.method === 'HEAD') && typeof req.url === 'string' &&
  (req.url === '/healthz' || req.url.startsWith('/healthz?'));

// Options: publicDir (required); getStats; cacheStatic (default true: the files are read once, now);
// trustProxy (proxies of our own in front, see clientIp); rate = { capacity, refillPerSec } limits requests
// per client address except the health check (default: no limit; the game server turns it on).
export function createHttpHandler({ publicDir, getStats, cacheStatic = true, trustProxy = 0, rate = null } = {}) {
  if (typeof publicDir !== 'string' || !publicDir) throw new TypeError('createHttpHandler: publicDir is required');
  const root = path.resolve(publicDir);
  const hops = proxyHops(trustProxy);
  const limiter = rate && typeof rate === 'object' ? createKeyedBuckets(rate.capacity, rate.refillPerSec) : null;
  const ctx = { root, getStats, cache: cacheStatic === false ? null : buildCache(root) };

  return (req, res) => {
    try {
      // A reset connection must not surface as an unhandled 'error' event.
      req.on('error', noop);
      res.on('error', noop);
      if (limiter && !isHealthCheck(req) && !limiter.take(clientIp(req, hops))) {
        return reply(req, res, 429, TEXT, 'Too many requests. Slow down.', { 'Retry-After': '1' });
      }
      Promise.resolve(route(req, res, ctx))
        .catch(() => reply(req, res, 500, TEXT, 'Server error'));
    } catch {
      reply(req, res, 500, TEXT, 'Server error');
    }
  };
}
