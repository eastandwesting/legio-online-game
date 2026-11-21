// NET track: lib/http.js, lib/limits.js, public/robots.txt.
// HTTP cases go over raw TCP sockets so that malformed request lines reach the
// server exactly as written (an HTTP client library would normalise them).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpHandler } from '../lib/http.js';
import { createTokenBucket, clientIp, createIpCounter } from '../lib/limits.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'TOP-SECRET-FIXTURE';
const INDEX = '<!doctype html><title>fixture</title><p>héllo</p>\n';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

let fixture, publicDir, server, port, hasLink = false;
let statsCalls = 0;

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

before(async () => {
  // A throwaway tree: the real public/ is being edited by other tracks.
  fs.mkdirSync(path.join(REPO, '.scratch', 'net'), { recursive: true });
  fixture = fs.mkdtempSync(path.join(REPO, '.scratch', 'net', 'fixture-'));
  publicDir = path.join(fixture, 'public');
  write(path.join(publicDir, 'index.html'), INDEX);
  write(path.join(publicDir, 'client.js'), 'console.log("fixture");\n');
  write(path.join(publicDir, 'style.css'), 'body{margin:0}\n');
  write(path.join(publicDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  write(path.join(publicDir, 'data.bin'), Buffer.from([0, 1, 2, 3, 255]));
  write(path.join(publicDir, 'sub', 'file.txt'), 'nested\n');
  write(path.join(publicDir, 'sub', '.hidden'), SECRET);
  write(path.join(publicDir, '.env'), SECRET);
  write(path.join(publicDir, '.well-known', 'x.txt'), SECRET);
  write(path.join(fixture, 'secret.txt'), SECRET);
  write(path.join(fixture, 'public-old', 'secret.txt'), SECRET);
  write(path.join(fixture, 'outside', 'secret.txt'), SECRET);
  try {
    // A junction needs no privilege on Windows; elsewhere this is a plain symlink.
    fs.symlinkSync(path.join(fixture, 'outside'), path.join(publicDir, 'link'), 'junction');
    hasLink = true;
  } catch { /* no link support here: that one test is skipped */ }

  const getStats = () => { statsCalls++; return { rooms: 2, connections: 5 }; };
  server = http.createServer(createHttpHandler({ publicDir, getStats }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

// Sends bytes as written; resolves with everything the server sent before closing.
function rawExchange(toPort, bytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(toPort, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no response within 5 s')); }, 5000);
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', c => chunks.push(c));
    socket.on('error', () => {}); // a reset after a 400 is fine; 'close' still follows
    socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('latin1')); });
  });
}

function parseResponse(text) {
  const split = text.indexOf('\r\n\r\n');
  const head = split < 0 ? text : text.slice(0, split);
  const lines = head.split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] || '');
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: m ? Number(m[1]) : 0, headers, body: split < 0 ? '' : text.slice(split + 4), raw: text };
}

// One request with the given request line target, written verbatim.
async function request(method, target, toPort = port) {
  const res = parseResponse(await rawExchange(toPort, `${method} ${target} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`));
  assert.ok(!res.raw.includes(SECRET), `${method} ${target} leaked a file from outside the public tree`);
  return res;
}
const get = (target, toPort) => request('GET', target, toPort);

async function assertHealthy() {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'ok');
}

function assertSecurityHeaders(res, label) {
  assert.equal(res.headers['x-content-type-options'], 'nosniff', label);
  assert.equal(res.headers['referrer-policy'], 'no-referrer', label);
  assert.equal(res.headers['x-frame-options'], 'DENY', label);
  assert.equal(res.headers['cache-control'], 'no-cache', label);
  assert.match(res.headers['content-length'] || '', /^\d+$/, label);
}

// ---------- static files ----------

test('GET / serves index.html with the CSP and the security headers', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['content-security-policy'], CSP);
  assertSecurityHeaders(res, '/');
  assert.equal(Buffer.from(res.body, 'latin1').toString('utf8'), INDEX);
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(INDEX));
});

test('a query string is ignored for files', async () => {
  for (const target of ['/?x=1', '/index.html?a=b&c=%zz', '/index.html?']) {
    const res = await get(target);
    assert.equal(res.status, 200, target);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', target);
  }
});

test('content types: text carries a charset, only HTML carries the CSP', async () => {
  const expected = {
    '/client.js': 'text/javascript; charset=utf-8',
    '/style.css': 'text/css; charset=utf-8',
    '/robots.txt': 'text/plain; charset=utf-8',
    '/sub/file.txt': 'text/plain; charset=utf-8',
    '/data.bin': 'application/octet-stream',
  };
  for (const [target, type] of Object.entries(expected)) {
    const res = await get(target);
    assert.equal(res.status, 200, target);
    assert.equal(res.headers['content-type'], type, target);
    assert.equal(res.headers['content-security-policy'], undefined, target);
    assertSecurityHeaders(res, target);
    assert.equal(Number(res.headers['content-length']), res.body.length, target);
  }
});

test('percent-encoded names of public files still resolve', async () => {
  const res = await get('/%63lient.js');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'console.log("fixture");\n');
});

test('HEAD sends the headers of GET and no body', async () => {
  const res = await request('HEAD', '/');
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(INDEX));
  assert.equal(res.headers['content-security-policy'], CSP);
  assert.equal(res.body, '');
  const missing = await request('HEAD', '/nope.txt');
  assert.equal(missing.status, 404);
  assert.equal(missing.body, '');
});

test('missing files, directories and directory-like targets are 404 text/plain', async () => {
  for (const target of ['/nope.html', '/sub', '/sub/', '/sub/nope.txt', '/index.html/', '/index.html/x', '/sub//file.txt']) {
    const res = await get(target);
    assert.equal(res.status, 404, target);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8', target);
    assertSecurityHeaders(res, target);
  }
});

test('any segment starting with a dot is 404, even when the file exists', async () => {
  for (const target of ['/.env', '/.well-known/x.txt', '/sub/.hidden', '/.', '/./index.html', '/sub/./file.txt', '/%2eenv']) {
    assert.equal((await get(target)).status, 404, target);
  }
});

test('names the operating system would alias are not served', async () => {
  // Same answer on every platform, including case-insensitive file systems.
  for (const target of ['/INDEX.HTML', '/Client.js', '/SUB/file.txt', '/index.html.', '/index.html%20',
    '/index.html::$DATA', '/client.js:x', '/CLIENT~1.JS', '/nul', '/con.txt', '/C:/Windows/win.ini']) {
    assert.equal((await get(target)).status, 404, target);
  }
});

test('a link that leaves the public directory is not followed', async t => {
  if (!hasLink) return t.skip('cannot create links on this machine');
  assert.equal((await get('/link/secret.txt')).status, 404);
  assert.equal((await get('/link')).status, 404);
});

// ---------- methods ----------

test('only GET and HEAD are allowed', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
    const res = await request(method, '/');
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET, HEAD', method);
    assertSecurityHeaders(res, method);
  }
  assert.equal((await request('OPTIONS', '*')).status, 405);
  assert.equal((await request('POST', '/healthz')).status, 405);
});

test('a refused POST body does not poison the next request on the connection', async () => {
  const text = await rawExchange(port,
    'POST / HTTP/1.1\r\nHost: test\r\nContent-Length: 5\r\n\r\nhello' +
    'GET /healthz HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n');
  // The 405 body has no trailing newline, so the second status line is not at a line start.
  const statuses = [...text.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map(m => m[1]);
  assert.deepEqual(statuses, ['405', '200']);
  assert.ok(text.endsWith('ok'));
});

// ---------- malformed and hostile request targets ----------

test('GET // does not crash the server (the v1 process killer)', async () => {
  for (const target of ['//', '///', '//index.html', '//evil.example/index.html', '/?//', '//?']) {
    const res = await get(target);
    assert.ok(res.status === 404 || res.status === 200, `${target} -> ${res.status}`);
  }
  assert.equal((await get('//')).status, 404);
  await assertHealthy();
});

test('undecodable escapes are 400', async () => {
  for (const target of ['/%zz', '/%', '/%e0%a4%a', '/index.html%', '/%ff', '/%c0%af']) {
    const res = await get(target);
    assert.equal(res.status, 400, target);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8', target);
    assertSecurityHeaders(res, target);
  }
  await assertHealthy();
});

test('NUL bytes and backslashes are 400, raw or encoded', async () => {
  for (const target of ['/%00', '/index.html%00', '/index.html%00.txt', '/..%5c', '/..%5C..%5Csecret.txt',
    '/%5c', '/sub%5cfile.txt', '/..\\', '/..\\secret.txt', '\\index.html', '/a\\..\\..\\secret.txt']) {
    assert.equal((await get(target)).status, 400, target);
  }
  await assertHealthy();
});

test('absolute-form and asterisk-form targets are 400', async () => {
  for (const target of ['http://evil.example/index.html', 'http://test/', 'https://test/index.html',
    'file:///etc/passwd', '*', 'index.html', '?x', 'evil.example:443']) {
    assert.equal((await get(target)).status, 400, target);
  }
  await assertHealthy();
});

test('traversal never leaves the public directory', async () => {
  const targets = ['/..', '/../', '/../secret.txt', '/../../secret.txt', '/sub/../../secret.txt',
    '/sub/../../../secret.txt', '/../public-old/secret.txt', '/../public/index.html', '/../outside/secret.txt',
    '/%2e%2e%2fsecret.txt', '/%2e%2e/secret.txt', '/%2E%2E%2Fsecret.txt', '/.%2e/secret.txt', '/%2e./secret.txt',
    '/..%2fsecret.txt', '/..%2f..%2fsecret.txt', '/sub%2f..%2f..%2fsecret.txt', '/%2e%2e%2fpublic-old%2fsecret.txt',
    '/%252e%252e%252fsecret.txt', '/..;/secret.txt', '/....//secret.txt', '/.../secret.txt', '/..%00/secret.txt',
    '/..%5csecret.txt', '/..%c0%afsecret.txt', '/%2e%2e%5csecret.txt'];
  for (const target of targets) {
    const res = await get(target); // request() already asserts the secret did not leak
    assert.ok(res.status === 400 || res.status === 404, `${target} -> ${res.status}`);
  }
  await assertHealthy();
});

test('a sibling directory sharing the prefix is not inside publicDir', async () => {
  // Handler rooted at .../public must not serve .../public-old, whatever the spelling of publicDir.
  for (const dir of [publicDir, publicDir + path.sep, path.join(publicDir, 'sub', '..')]) {
    const other = http.createServer(createHttpHandler({ publicDir: dir }));
    await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
    try {
      const p = other.address().port;
      assert.equal((await get('/index.html', p)).status, 200, dir);
      assert.equal((await get('/../public-old/secret.txt', p)).status, 404, dir);
      assert.equal((await get('/-old/secret.txt', p)).status, 404, dir);
    } finally {
      await new Promise(resolve => other.close(resolve));
    }
  }
});

test('an over-long target is refused without touching the disk', async () => {
  const res = await get('/' + 'a'.repeat(4000));
  assert.equal(res.status, 414);
  await assertHealthy();
});

test('garbage request lines and aborted requests leave the server healthy', async () => {
  const lines = ['GET\r\n\r\n', 'GET / HTTP/9.9\r\n\r\n', '\x00\x01\x02\r\n\r\n', 'GET /a b HTTP/1.1\r\n\r\n',
    'GET /\x00 HTTP/1.1\r\nHost: t\r\n\r\n', 'GET /index.html HTTP/1.1\r\nHost: t\r\nContent-Length: x\r\n\r\n',
    'GET /\xff\xfe HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n', 'G'.repeat(20000) + '\r\n\r\n'];
  for (const line of lines) {
    const res = parseResponse(await rawExchange(port, Buffer.from(line, 'latin1')));
    assert.ok(res.status === 0 || (res.status >= 400 && res.status < 500), `${JSON.stringify(line.slice(0, 30))} -> ${res.status}`);
    assert.ok(!res.raw.includes(SECRET));
  }
  // Hang up straight after the request, before the async file read answers.
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET /index.html HTTP/1.1\r\nHost: t\r\n\r\n', () => { socket.destroy(); resolve(); });
      });
      socket.on('error', resolve);
    });
  }
  await assertHealthy();
});

test('seeded fuzz of hostile targets: never a 5xx, never a leak, server stays up', async () => {
  const parts = ['/', '/', '..', '.', '%2e', '%2E%2e', '%2f', '%5c', '\\', '%00', '%', '%zz', '?', '#', ':', ';',
    '~', '*', 'index.html', 'secret.txt', 'public-old', 'outside', 'sub', 'link', 'http://', '%c0%af', '%25', '+', '@'];
  let seed = 0x2f6e73c1;
  const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 300; i++) {
    let target = rnd(8) === 0 ? '' : '/';
    for (let k = 1 + rnd(7); k > 0; k--) target += parts[rnd(parts.length)];
    const res = await get(target);
    assert.ok([200, 400, 404].includes(res.status), `${JSON.stringify(target)} -> ${res.status}`);
    if (res.status === 200) assert.ok(res.body === INDEX.replace('é', '\xc3\xa9') || res.body === 'ok', `${JSON.stringify(target)} served something unexpected`);
  }
  await assertHealthy();
});

test('the handler itself never throws, even on a nonsense request object', () => {
  const handler = createHttpHandler({ publicDir });
  const sent = [];
  const fakeRes = () => ({
    headersSent: false, destroyed: false, on() {},
    writeHead(status) { sent.push(status); this.headersSent = true; }, end() {}, destroy() {},
  });
  for (const req of [{ method: 'GET', on() {} }, { method: 'GET', url: 42, on() {} }, { method: 'GET', url: null, on() {} },
    { url: '/', on() {} }, { method: 'GET', url: '/' }, {}, { method: 'GET', url: '', on() {} }]) {
    assert.doesNotThrow(() => handler(req, fakeRes()));
  }
  assert.doesNotThrow(() => handler(null, fakeRes()));
  assert.doesNotThrow(() => handler({ method: 'GET', url: '/', on() {} }, null));
  assert.ok(sent.every(status => status >= 400 && status < 600));
  assert.throws(() => createHttpHandler({}), TypeError); // a start-up mistake, reported at start-up
});

// ---------- health check ----------

test('/healthz answers ok and exposes stats only on request', async () => {
  statsCalls = 0;
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(res.body, 'ok');
  assertSecurityHeaders(res, '/healthz');
  assert.equal((await get('/healthz?x=1')).body, 'ok');
  assert.equal((await get('/healthz?nostats')).body, 'ok');
  assert.equal(statsCalls, 0);
  assert.equal((await request('HEAD', '/healthz')).status, 200);

  for (const target of ['/healthz?stats', '/healthz?stats=1', '/healthz?a=b&stats']) {
    const stats = await get(target);
    assert.equal(stats.status, 200, target);
    assert.equal(stats.headers['content-type'], 'application/json; charset=utf-8', target);
    assert.deepEqual(JSON.parse(stats.body), { rooms: 2, connections: 5 }, target);
  }
  assert.equal((await get('/healthz/')).status, 404);
  assert.equal((await get('/healthz.txt')).status, 404);
});

test('/healthz does not need the disk or a working stats callback', async () => {
  const broken = { toJSON() { throw new Error('boom'); } };
  for (const getStats of [undefined, () => { throw new Error('boom'); }, () => broken, () => undefined, 'nope']) {
    const handler = createHttpHandler({ publicDir: path.join(fixture, 'does-not-exist'), getStats });
    const other = http.createServer(handler);
    await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
    try {
      const p = other.address().port;
      const res = await get('/healthz?stats', p);
      assert.equal(res.status, 200);
      assert.equal(res.body, 'ok');
      assert.equal((await get('/', p)).status, 404); // no public directory: plain 404, no crash
    } finally {
      await new Promise(resolve => other.close(resolve));
    }
  }
});

// ---------- robots.txt (the real one) ----------

test('public/robots.txt keeps crawlers out', () => {
  const lines = fs.readFileSync(path.join(REPO, 'public', 'robots.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.deepEqual(lines, ['User-agent: *', 'Disallow: /']);
});

// ---------- token bucket ----------

test('token bucket: starts full, refuses when empty, refills by elapsed time', () => {
  let t = 1_000_000;
  const bucket = createTokenBucket(5, 2, () => t);
  for (let i = 0; i < 5; i++) assert.equal(bucket.take(), true, `take ${i}`);
  assert.equal(bucket.take(), false);
  t += 499;                       // 0.998 tokens
  assert.equal(bucket.take(), false);
  t += 1;                         // 1 token
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  t += 1500;                      // 3 tokens
  assert.equal(bucket.take(2), true);
  assert.equal(bucket.take(2), false); // a refused take costs nothing
  assert.equal(bucket.take(1), true);
  assert.equal(bucket.take(1), false);
});

test('token bucket: refill is capped at capacity', () => {
  let t = 0;
  const bucket = createTokenBucket(3, 100, () => t);
  t += 3_600_000;
  for (let i = 0; i < 3; i++) assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  assert.equal(createTokenBucket(3, 100, () => t).take(4), false); // more than it can ever hold
});

test('token bucket: the SPEC default (60, 30/s) sustains 30 messages per second', () => {
  let t = 0;
  const bucket = createTokenBucket(60, 30, () => t);
  let ok = 0;
  for (let i = 0; i < 200; i++) if (bucket.take()) ok++;   // one burst
  assert.equal(ok, 60);
  ok = 0;
  for (let ms = 0; ms < 10_000; ms += 10) { t += 10; if (bucket.take()) ok++; } // 100 msg/s for 10 s
  assert.ok(ok >= 299 && ok <= 301, `passed ${ok} of 1000`);
});

test('token bucket: odd clocks and odd arguments are safe', () => {
  let t = 10_000;
  const bucket = createTokenBucket(2, 1, () => t);
  assert.equal(bucket.take(2), true);
  t -= 5000;                      // clock stepped back: no refill, no stall
  assert.equal(bucket.take(), false);
  t += 1000;
  assert.equal(bucket.take(), true);
  t = NaN;
  assert.equal(bucket.take(), false);
  t = 6000 + 2000;
  assert.equal(bucket.take(2), true);

  t += 60_000;                    // full again
  assert.equal(bucket.take(-5), false);   // must not mint tokens
  assert.equal(bucket.take(NaN), false);
  assert.equal(bucket.take('x'), false);
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(2), true);
  assert.equal(bucket.take(), false);

  for (const [capacity, refill] of [[NaN, 1], [-1, 1], ['x', 1], [undefined, undefined]]) {
    assert.equal(createTokenBucket(capacity, refill).take(), false); // bad config denies, never throws
  }
  assert.equal(createTokenBucket(1, NaN).take(), true);
  assert.equal(createTokenBucket(2, 5).take(), true); // default clock
  assert.equal(createTokenBucket(2, 5, null).take(), true); // not a function: default clock
});

// ---------- client address ----------

const fakeReq = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

test('clientIp: socket address unless the proxy is trusted', () => {
  assert.equal(clientIp(fakeReq('203.0.113.9', '198.51.100.7'), false), '203.0.113.9');
  assert.equal(clientIp(fakeReq('203.0.113.9', '198.51.100.7'), undefined), '203.0.113.9');
  assert.equal(clientIp(fakeReq('::ffff:203.0.113.9'), false), '203.0.113.9');
  assert.equal(clientIp(fakeReq('2001:DB8::1'), false), '2001:db8::1');
  assert.equal(clientIp(fakeReq('::1'), false), '::1');
});

test('clientIp: first X-Forwarded-For hop when the proxy is trusted', () => {
  assert.equal(clientIp(fakeReq('10.0.0.1', '198.51.100.7'), true), '198.51.100.7');
  assert.equal(clientIp(fakeReq('10.0.0.1', ' 198.51.100.7 , 10.0.0.2, 10.0.0.3'), true), '198.51.100.7');
  assert.equal(clientIp(fakeReq('10.0.0.1', ['198.51.100.7, 10.0.0.2', '10.0.0.3']), true), '198.51.100.7');
  assert.equal(clientIp(fakeReq('10.0.0.1', '198.51.100.7:51234'), true), '198.51.100.7');
  assert.equal(clientIp(fakeReq('10.0.0.1', '[2001:db8::2]:443, 10.0.0.2'), true), '2001:db8::2');
  assert.equal(clientIp(fakeReq('10.0.0.1', '::ffff:198.51.100.7'), true), '198.51.100.7');
});

test('clientIp: a missing or forged header falls back to the socket address', () => {
  const junk = [undefined, '', ' ', ',', 'unknown', 'localhost', '<script>', '1.2.3', '999.1.1.1', '__proto__',
    'a'.repeat(5000), '1.2.3.4\r\nX-Evil: 1', '\0', 42, {}, [], ['']];
  for (const xff of junk) {
    assert.equal(clientIp(fakeReq('10.0.0.1', xff), true), '10.0.0.1', JSON.stringify(xff)?.slice(0, 40));
  }
});

test('clientIp: an integer trusts that many proxies, counted from the right', () => {
  const req = fakeReq('10.0.0.1', '6.6.6.6, 198.51.100.7, 10.0.0.2'); // 6.6.6.6 was sent by the client itself
  assert.equal(clientIp(req, true), '6.6.6.6');        // SPEC behaviour: first hop
  assert.equal(clientIp(req, 1), '10.0.0.2');
  assert.equal(clientIp(req, 2), '198.51.100.7');
  assert.equal(clientIp(req, 3), '6.6.6.6');
  assert.equal(clientIp(req, 4), '10.0.0.1');          // fewer hops than expected: socket address
  assert.equal(clientIp(req, 0), '10.0.0.1');
  assert.equal(clientIp(req, 1.5), '10.0.0.1');
  assert.equal(clientIp(req, 'yes'), '10.0.0.1');
});

test('clientIp: always a string, never a throw', () => {
  for (const req of [undefined, null, {}, { socket: null }, { socket: {} }, { headers: null, socket: { remoteAddress: 7 } },
    { socket: { remoteAddress: 'not an ip' } }]) {
    assert.equal(clientIp(req, true), 'unknown');
    assert.equal(clientIp(req, false), 'unknown');
  }
});

test('clientIp: works on a real request', async () => {
  const seen = [];
  const probe = http.createServer((req, res) => { seen.push(clientIp(req, false), clientIp(req, true)); res.end(); });
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  try {
    await rawExchange(probe.address().port,
      'GET / HTTP/1.1\r\nHost: t\r\nX-Forwarded-For: 198.51.100.7\r\nX-Forwarded-For: 10.0.0.2\r\nConnection: close\r\n\r\n');
  } finally {
    await new Promise(resolve => probe.close(resolve));
  }
  assert.deepEqual(seen, ['127.0.0.1', '198.51.100.7']);
});

// ---------- per-address counter ----------

test('ip counter: caps each address separately and frees slots on remove', () => {
  const counter = createIpCounter(2);
  assert.equal(counter.count('1.1.1.1'), 0);
  assert.equal(counter.add('1.1.1.1'), true);
  assert.equal(counter.add('1.1.1.1'), true);
  assert.equal(counter.add('1.1.1.1'), false);
  assert.equal(counter.count('1.1.1.1'), 2);   // a refused add is not counted
  assert.equal(counter.add('2.2.2.2'), true);
  assert.equal(counter.count('2.2.2.2'), 1);
  counter.remove('1.1.1.1');
  assert.equal(counter.count('1.1.1.1'), 1);
  assert.equal(counter.add('1.1.1.1'), true);
  assert.equal(counter.add('1.1.1.1'), false);
});

test('ip counter: never goes negative and unknown addresses are harmless', () => {
  const counter = createIpCounter(1);
  counter.remove('9.9.9.9');
  counter.remove('9.9.9.9');
  assert.equal(counter.count('9.9.9.9'), 0);
  assert.equal(counter.add('9.9.9.9'), true);
  assert.equal(counter.add('9.9.9.9'), false);
  counter.remove('9.9.9.9');
  counter.remove('9.9.9.9');
  assert.equal(counter.count('9.9.9.9'), 0);
  assert.equal(counter.add('9.9.9.9'), true);
});

test('ip counter: prototype names and odd keys are ordinary keys', () => {
  const counter = createIpCounter(1);
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'unknown']) {
    assert.equal(counter.count(key), 0, key);
    assert.equal(counter.add(key), true, key);
    assert.equal(counter.add(key), false, key);
    assert.equal(counter.count(key), 1, key);
    counter.remove(key);
    assert.equal(counter.count(key), 0, key);
  }
  assert.equal(counter.add(undefined), true);
  assert.equal(counter.count('undefined'), 1);
  assert.equal({}.polluted, undefined);
});

test('ip counter: a bad limit denies instead of throwing; Infinity means no limit', () => {
  for (const max of [0, -1, NaN, undefined, 'x']) assert.equal(createIpCounter(max).add('1.1.1.1'), false, String(max));
  const open = createIpCounter(Infinity);
  for (let i = 0; i < 1000; i++) assert.equal(open.add('1.1.1.1'), true);
  assert.equal(open.count('1.1.1.1'), 1000);
});

test('ip counter: the SPEC default of 20 per address', () => {
  const counter = createIpCounter(20);
  let ok = 0;
  for (let i = 0; i < 50; i++) if (counter.add('198.51.100.7')) ok++;
  assert.equal(ok, 20);
  for (let i = 0; i < 50; i++) counter.remove('198.51.100.7');
  assert.equal(counter.count('198.51.100.7'), 0);
});
