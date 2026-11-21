// Static files and the health check for the public edge. Every request target
// is hostile input: nothing here may throw, and no stream error may escape.
import fs from 'node:fs/promises';
import path from 'node:path';

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

async function serveFile(req, res, root, segments) {
  let body = null;
  try {
    body = await readPublicFile(root, segments);
  } catch (err) {
    if (!MISSING.has(err?.code)) return reply(req, res, 500, TEXT, 'Server error');
  }
  if (!body) return notFound(req, res);
  const type = MIME[path.extname(segments[segments.length - 1]).toLowerCase()] || 'application/octet-stream';
  reply(req, res, 200, type, body, type === HTML ? { 'Content-Security-Policy': CSP } : undefined);
}

function route(req, res, root, getStats) {
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

  if (pathname === '/healthz') return health(req, res, query, getStats); // never touches the disk
  if (pathname === '/') pathname = '/index.html';

  // Empty segments ('//', trailing '/') are refused too: no directory indexes.
  const segments = pathname.slice(1).split('/');
  if (!segments.every(s => SEGMENT.test(s))) return notFound(req, res);
  return serveFile(req, res, root, segments);
}

export function createHttpHandler({ publicDir, getStats } = {}) {
  if (typeof publicDir !== 'string' || !publicDir) throw new TypeError('createHttpHandler: publicDir is required');
  const root = path.resolve(publicDir);

  return (req, res) => {
    try {
      // A reset connection must not surface as an unhandled 'error' event.
      req.on('error', noop);
      res.on('error', noop);
      Promise.resolve(route(req, res, root, getStats))
        .catch(() => reply(req, res, 500, TEXT, 'Server error'));
    } catch {
      reply(req, res, 500, TEXT, 'Server error');
    }
  };
}
