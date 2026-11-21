// Public-hosting limits of the game server (SPEC 7.2): rooms per address, lobby expiry, failed joins, the
// WebSocket Origin check, and the per-address limits on HTTP requests and WebSocket upgrades.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, startTestServer, connect, sleep } from './harness.mjs';

async function server(t, options) {
  const s = await startTestServer(options);
  t.after(() => s.close());
  return s;
}
const until = async (fn, ms = 3000) => { for (let i = 0; i < ms / 5 && !fn(); i++) await sleep(5); assert.ok(fn(), 'condition not reached in time'); };
const from = (s, ip, extra = {}) => connect(s.wsUrl, { headers: { 'X-Forwarded-For': ip, ...extra } });

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// One socket per room (a seated socket ignores create). Resolves with the first answer of each.
async function openRooms(s, ip, n, t = 'create') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = await from(s, ip);
    c.send({ t, name: 'N' + i });
    out.push({ c, answer: await c.next(m => m.t === 'room' || m.t === 'error') });
  }
  return out;
}

// ---------- rooms per address (SPEC 7.2) ----------

test('an address owns at most 4 rooms, connected or not: the next create is too_many_rooms, another address is unaffected', async t => {
  const s = await server(t, { trustProxy: 1, maxRooms: 20 });
  const mine = await openRooms(s, '198.51.100.9', 5);
  assert.deepEqual(mine.map(r => r.answer.t), ['room', 'room', 'room', 'room', 'error']);
  assert.deepEqual(mine[4].answer, { t: 'error', code: 'too_many_rooms',
    msg: 'You already have several games open from this connection. Close one first.' });
  assert.equal(s.game.stats().rooms, 4);
  // practice and campaign rooms count as well, and the refusal is the same
  const more = await openRooms(s, '198.51.100.9', 1, 'practice');
  assert.equal(more[0].answer.code, 'too_many_rooms');
  // another address is not affected
  const other = await openRooms(s, '203.0.113.7', 1);
  assert.equal(other[0].answer.t, 'room');
  // closing one of the four makes room for exactly one more
  mine[0].c.send({ t: 'leave' });
  await mine[0].c.next('left');
  await until(() => s.game.stats().rooms === 4);
  const again = await openRooms(s, '198.51.100.9', 2);
  assert.deepEqual(again.map(r => r.answer.t), ['room', 'error']);
});

test('two addresses holding rooms with live sockets cannot lock everybody else out (regression: 60 rooms pinned by 2 addresses)', async t => {
  const s = await server(t, { trustProxy: 1, maxRooms: 10, maxPerIp: 40 });
  const a = await openRooms(s, '198.51.100.1', 40);
  const b = await openRooms(s, '198.51.100.2', 40);
  assert.equal(a.filter(r => r.answer.t === 'room').length, 4);
  assert.equal(b.filter(r => r.answer.t === 'room').length, 4);
  assert.ok(a.slice(4).every(r => r.answer.code === 'too_many_rooms'));
  assert.equal(s.game.stats().rooms, 8);
  // a legitimate player still gets a room, for create and for practice
  const ok = await openRooms(s, '192.0.2.5', 1);
  assert.equal(ok[0].answer.t, 'room');
  const practice = await openRooms(s, '192.0.2.6', 1, 'practice');
  assert.equal(practice[0].answer.t, 'room');
  // at maxRooms the answer is still server_full, and nobody's room is touched
  const full = await openRooms(s, '192.0.2.7', 1);
  assert.equal(full[0].answer.code, 'server_full');
  assert.equal(s.game.stats().rooms, 10);
});

test('refusing at the cap never destroys another address\'s room, but an address gives up its own abandoned room first', async t => {
  const s = await server(t, { trustProxy: 1, maxRooms: 20, graceMs: 20000 });
  const other = await openRooms(s, '203.0.113.50', 1);
  const mine = await openRooms(s, '198.51.100.9', 4);
  // two of mine are abandoned (sockets gone, seats held for the grace period), two are connected. The server picks
  // the room lost first by millisecond timestamps, so lose them one after the other with a gap: two closes in the
  // same tick can arrive in either order or share a millisecond, and then "oldest" would be a coin toss.
  mine[0].c.terminate();
  await until(() => s.game.stats().connections === 4);
  await sleep(20);
  mine[1].c.terminate();
  await until(() => s.game.stats().connections === 3);
  const fifth = await openRooms(s, '198.51.100.9', 1);
  assert.equal(fifth[0].answer.t, 'room', 'at the cap, the oldest abandoned room of that address makes way');
  assert.equal(s.game._rooms.has(mine[0].answer.code), false, 'the oldest abandoned one went');
  assert.equal(s.game._rooms.has(mine[1].answer.code), true, 'only one');
  assert.equal(s.game._rooms.has(other[0].answer.code), true, 'another address\'s room is never touched');
  // now only one abandoned room is left: one more create takes it, the next is refused
  const sixth = await openRooms(s, '198.51.100.9', 1);
  assert.equal(sixth[0].answer.t, 'room');
  assert.equal(s.game._rooms.has(mine[1].answer.code), false);
  const seventh = await openRooms(s, '198.51.100.9', 1);
  assert.equal(seventh[0].answer.code, 'too_many_rooms', 'four connected rooms: nothing to give up');
  assert.equal(s.game._rooms.has(mine[2].answer.code) && s.game._rooms.has(mine[3].answer.code), true, 'connected rooms are never destroyed');
});

test('maxRoomsPerIp and MAX_ROOMS_PER_IP set the cap; the option wins; an invalid value is ignored', async t => {
  const two = await server(t, { trustProxy: 1, maxRoomsPerIp: 2 });
  assert.deepEqual((await openRooms(two, '198.51.100.9', 3)).map(r => r.answer.t), ['room', 'room', 'error']);
  await withEnv({ MAX_ROOMS_PER_IP: '3' }, async () => {
    const s = await server(t, { trustProxy: 1 });
    assert.deepEqual((await openRooms(s, '198.51.100.9', 4)).map(r => r.answer.t), ['room', 'room', 'room', 'error']);
    const o = await server(t, { trustProxy: 1, maxRoomsPerIp: 1 });
    assert.deepEqual((await openRooms(o, '198.51.100.9', 2)).map(r => r.answer.t), ['room', 'error'], 'the option beats the environment');
  });
  for (const bad of ['lots', '0', '-2', '1.5', '']) {
    await withEnv({ MAX_ROOMS_PER_IP: bad }, async () => {
      const s = await server(t, { trustProxy: 1 });
      assert.deepEqual((await openRooms(s, '198.51.100.9', 5)).map(r => r.answer.t), ['room', 'room', 'room', 'room', 'error'], `MAX_ROOMS_PER_IP=${bad}`);
    });
  }
});

// ---------- lobby expiry ----------

test('a lobby with fewer than two humans is closed after lobbyMaxMs however much ping and ready traffic it gets', async t => {
  const s = await server(t, { lobbyMaxMs: 300 });   // idleRoomMs stays at 45 minutes: only the lobby limit can fire
  const a = await connect(s.wsUrl);
  a.send({ t: 'create', name: 'Squatter' });
  const { code } = await a.next('room');
  const start = Date.now();
  while (!a.msgs.some(m => m.t === 'left') && Date.now() - start < 3000) {
    a.send({ t: 'ready' }); a.send({ t: 'ping' });   // "activity" of every kind
    await sleep(25);
  }
  const left = a.msgs.find(m => m.t === 'left');
  assert.deepEqual(left, { t: 'left', reason: 'idle' });
  assert.ok(Date.now() - start >= 250, 'not before the limit');
  assert.equal(s.game._rooms.has(code), false);
  assert.equal(s.game.stats().rooms, 0);
});

test('lobbyMaxMs does not touch a lobby with two humans, or a game that is running', async t => {
  const s = await server(t, { lobbyMaxMs: 250 });
  const a = await connect(s.wsUrl), b = await connect(s.wsUrl);
  a.send({ t: 'create', name: 'A' });
  const { code } = await a.next('room');
  b.send({ t: 'join', code, name: 'B' });
  await b.next('room');
  const solo = await connect(s.wsUrl);
  solo.send({ t: 'practice', name: 'Solo' });
  const soloRoom = await solo.next('room');
  solo.send({ t: 'ready' });                         // the practice game starts: no longer a lobby
  await solo.next('start');
  await sleep(700);
  assert.equal(s.game._rooms.has(code), true, 'two humans');
  assert.equal(s.game._rooms.has(soloRoom.code), true, 'a running game');
  assert.deepEqual(a.msgs.filter(m => m.t === 'left'), []);
  // when the second human goes, the lobby has one human again and a new clock
  b.send({ t: 'leave' });
  await b.next('left');
  const seatsAt = s.game._rooms.get(code).seatsAt;
  assert.ok(Date.now() - seatsAt < 250, 'a seat change restarts the lobby clock');
  assert.deepEqual(await a.next('left', 3000), { t: 'left', reason: 'idle' });
});

// ---------- failed joins (SPEC 7.2) ----------

test('only a code that does not exist counts as a failed join; a full or started room does not', async t => {
  const s = await server(t, { trustProxy: 1 });
  const { code } = await (async () => { const h = await from(s, '203.0.113.1'); h.send({ t: 'create', name: 'H' }); return h.next('room'); })();
  const guest = await from(s, '203.0.113.2');
  guest.send({ t: 'join', code, name: 'G' });
  await guest.next('room');                          // the room is full now
  const crowd = [];
  for (let i = 0; i < 12; i++) crowd.push(await from(s, '198.51.100.9'));
  for (const c of crowd) { c.send({ t: 'join', code, name: 'C' }); assert.equal((await c.next('error')).code, 'bad_room'); }
  // 12 joins of a full room later the same address can still join an open one
  const open = await from(s, '203.0.113.3');
  open.send({ t: 'create', name: 'O' });
  const openCode = (await open.next('room')).code;
  const late = await from(s, '198.51.100.9');
  late.send({ t: 'join', code: openCode, name: 'Late' });
  assert.equal((await late.next(m => m.t === 'room' || m.t === 'error')).t, 'room', 'not blocked: nothing nonexistent was named');
  // the same for a room whose game has started
  const a = await from(s, '203.0.113.4'), b = await from(s, '203.0.113.5');
  a.send({ t: 'create', name: 'A' });
  const started = (await a.next('room')).code;
  b.send({ t: 'join', code: started, name: 'B' }); await b.next('room');
  a.send({ t: 'ready' }); b.send({ t: 'ready' });
  await a.next('start');
  const peeker = await from(s, '198.51.100.10');
  for (let i = 0; i < 10; i++) { peeker.send({ t: 'join', code: started, name: 'P' }); assert.equal((await peeker.next('error')).code, 'bad_room'); }
  const open2 = await from(s, '203.0.113.6');
  open2.send({ t: 'create', name: 'O2' });
  peeker.send({ t: 'join', code: (await open2.next('room')).code, name: 'P' });
  assert.equal((await peeker.next(m => m.t === 'room' || m.t === 'error')).t, 'room');
});

test('a successful join clears the address\'s failure count; the blocked answer says why', async t => {
  const s = await server(t, { trustProxy: 1 });
  const host = await from(s, '203.0.113.1');
  host.send({ t: 'create', name: 'Host' });
  const { code } = await host.next('room');
  const guesser = await from(s, '198.51.100.9');
  for (let i = 0; i < 7; i++) { guesser.send({ t: 'join', code: 'ZZZ' + i, name: 'G' }); assert.equal((await guesser.next('error')).code, 'bad_room'); }
  guesser.send({ t: 'join', code, name: 'G' });
  await guesser.next('room');                        // success: the 7 misses are forgotten
  guesser.send({ t: 'leave' });
  await guesser.next('left');
  for (let i = 0; i < 7; i++) { guesser.send({ t: 'join', code: 'YYY' + i, name: 'G' }); assert.equal((await guesser.next('error')).code, 'bad_room', `miss ${i + 1} after the success`); }
  guesser.send({ t: 'join', code: 'XXXX', name: 'G' });
  assert.equal((await guesser.next('error')).code, 'bad_room');   // the 8th miss since the success
  guesser.send({ t: 'join', code, name: 'G' });
  assert.deepEqual(await guesser.next('error'), { t: 'error', code: 'rate', msg: 'Too many wrong room codes. Wait a minute and try again.' });
});

// ---------- WebSocket Origin (SPEC 7.2) ----------

const refused = async (s, headers) => {
  const err = await connect(s.wsUrl, { headers }).then(() => null, e => e);
  assert.ok(err, `Origin ${JSON.stringify(headers.Origin)} was accepted`);
  return String(err.message);
};

test('Origin: same-origin and Origin-less clients connect; a page of another site does not', async t => {
  const s = await server(t);
  const host = `127.0.0.1:${s.port}`;
  for (const headers of [{}, { Origin: `http://${host}` }, { Origin: `http://${host.toUpperCase()}` }, { Origin: `HTTP://${host}` }]) {
    const c = await connect(s.wsUrl, { headers });
    c.send({ t: 'ping', n: 1 });
    assert.equal((await c.next('pong')).n, 1, JSON.stringify(headers));
  }
  for (const origin of ['https://evil.example', 'http://127.0.0.1:1', `http://localhost:${s.port}`, `http://127.0.0.1.evil.example:${s.port}`,
    `http://evil.example:${s.port}`, 'http://127.0.0.1']) {
    assert.match(await refused(s, { Origin: origin }), /403/, origin);
  }
  assert.equal(s.game.stats().connections, 4, 'refused upgrades never became connections');
  const health = await fetch(`${s.httpUrl}/healthz`);
  assert.equal(health.status, 200, 'still serving');
});

test('Origin: host comparison ignores case and uses the Host header of the request', async t => {
  const s = await server(t);
  const c = await connect(s.wsUrl, { headers: { Host: 'Example.COM:8080', Origin: 'http://example.com:8080' } });
  c.send({ t: 'ping' });
  await c.next('pong');
  const d = await connect(s.wsUrl, { headers: { Host: 'example.com', Origin: 'https://EXAMPLE.com' } });
  d.send({ t: 'ping' });
  await d.next('pong');
  assert.match(await refused(s, { Host: 'example.com', Origin: 'https://example.com:8443' }), /403/, 'a different port is a different host');
  assert.match(await refused(s, { Host: 'example.com:8080', Origin: 'http://example.com' }), /403/);
});

test('Origin: malformed values are refused ("null", garbage, other schemes, paths, user info, empty)', async t => {
  const s = await server(t);
  for (const origin of ['null', 'garbage', '', ' ', 'http://', 'https:///', 'javascript:alert(1)', 'file:///etc/passwd', 'ws://' + `127.0.0.1:${s.port}`,
    `http://127.0.0.1:${s.port}/x`, `http://127.0.0.1:${s.port}/`.replace('/', '/?q'), `http://user@127.0.0.1:${s.port}`, '*',
    `http://127.0.0.1:${s.port}, https://evil.example`, 'http://[::1', 'x'.repeat(5000)]) {
    assert.match(await refused(s, { Origin: origin }), /403/, JSON.stringify(origin.slice(0, 40)));
  }
  assert.equal(s.game.stats().connections, 0);
});

test('Origin: allowedOrigins (option or ALLOWED_ORIGINS) lists the other sites that may connect', async t => {
  const listed = await server(t, { allowedOrigins: ['https://example.com', 'https://app.example.org:8443', 'not an origin', 'ftp://x.example'] });
  for (const origin of ['https://example.com', 'https://EXAMPLE.com', 'https://app.example.org:8443']) {
    const c = await connect(listed.wsUrl, { headers: { Origin: origin } });
    c.send({ t: 'ping' });
    await c.next('pong');
  }
  for (const origin of ['http://example.com', 'https://example.com:444', 'https://evil.example', 'https://app.example.org', 'ftp://x.example']) {
    assert.match(await refused(listed, { Origin: origin }), /403/, origin);
  }
  await withEnv({ ALLOWED_ORIGINS: ' https://a.example , https://b.example:9000,,garbage' }, async () => {
    const s = await server(t);
    for (const origin of ['https://a.example', 'https://b.example:9000']) {
      const c = await connect(s.wsUrl, { headers: { Origin: origin } });
      c.send({ t: 'ping' });
      await c.next('pong');
    }
    assert.match(await refused(s, { Origin: 'https://c.example' }), /403/);
    // an option beats the environment
    const o = await server(t, { allowedOrigins: [] });
    assert.match(await refused(o, { Origin: 'https://a.example' }), /403/);
  });
});

// ---------- per-address limits on upgrades and HTTP requests ----------

// A WebSocket handshake written by hand; resolves with the response head once it starts, then hangs up.
function rawUpgrade(port, headers = '') {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => { sock.destroy(); resolve(''); }, 3000);
    sock.on('connect', () => sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`));
    sock.on('data', chunk => { clearTimeout(timer); sock.destroy(); resolve(chunk.toString('latin1')); });
    sock.on('error', () => {});
  });
}
const statusOf = text => Number((/^HTTP\/1\.1 (\d{3})/.exec(text) || [])[1]);

test('upgrades: 10 at once, then about 2 a second per address; the refusal is a 429 on the raw socket, before any handshake', async t => {
  const s = await server(t, { upgradeRate: undefined, trustProxy: 1, maxPerIp: 100 });
  const heads = [];
  for (let i = 0; i < 20; i++) heads.push(await rawUpgrade(s.port, 'X-Forwarded-For: 198.51.100.9\r\n'));
  const statuses = heads.map(statusOf);
  const ok = statuses.filter(x => x === 101).length;
  assert.ok(ok >= 10 && ok <= 15, `${ok} upgrades got through: ${statuses.join(' ')}`);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(101));
  const limited = heads.find(h => statusOf(h) === 429);
  assert.ok(limited, 'a 429 after the burst');
  assert.match(limited, /Retry-After: 1\r\n/);
  assert.doesNotMatch(limited, /Sec-WebSocket-Accept/i, 'no handshake happened');
  assert.ok(s.game.stats().connections <= 15);
  // another address has a bucket of its own; the first address is still limited
  assert.equal(statusOf(await rawUpgrade(s.port, 'X-Forwarded-For: 203.0.113.7\r\n')), 101);
  assert.equal(statusOf(await rawUpgrade(s.port, 'X-Forwarded-For: 198.51.100.9\r\n')), 429);
  // it refills: after a second or so a handshake is accepted again
  await sleep(1100);
  assert.equal(statusOf(await rawUpgrade(s.port, 'X-Forwarded-For: 198.51.100.9\r\n')), 101);
  assert.equal((await fetch(`${s.httpUrl}/healthz`)).status, 200);
});

test('upgrades: a refused one is answered even by a client that is not a WebSocket library, and the server stays healthy', async t => {
  const s = await server(t, { upgradeRate: { capacity: 1, refillPerSec: 0 } });
  assert.equal(statusOf(await rawUpgrade(s.port)), 101);
  for (let i = 0; i < 5; i++) assert.equal(statusOf(await rawUpgrade(s.port)), 429);
  // a plain GET with an Upgrade header that is not a WebSocket one is just refused, not a crash
  const text = await new Promise(resolve => {
    const sock = net.connect(s.port, '127.0.0.1');
    let got = '';
    sock.on('connect', () => sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n'));
    sock.on('data', d => { got += d; });
    sock.on('close', () => resolve(got));
    sock.on('error', () => {});
    setTimeout(() => sock.destroy(), 1500);
  });
  assert.match(text, /^HTTP\/1\.1 (4\d\d)/);
  assert.equal((await fetch(`${s.httpUrl}/healthz`)).status, 200);
});

// A burst of requests over keep-alive sockets; resolves with the status codes.
function burst(port, target, n, headers = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  const one = () => new Promise(resolve => {
    http.get({ host: '127.0.0.1', port, path: target, agent, headers }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', () => resolve({ status: 0, headers: {}, body: '' }));
  });
  return Promise.all(Array.from({ length: n }, one)).finally(() => agent.destroy());
}

test('HTTP: 40 requests at once, then 20 a second per address; 429 with Retry-After; /healthz and other addresses are not limited', async t => {
  const s = await server(t, { httpRate: undefined, trustProxy: 1 });
  const mine = { 'X-Forwarded-For': '198.51.100.9' };
  const res = await burst(s.port, '/client.js', 100, mine);
  const ok = res.filter(r => r.status === 200).length, limited = res.filter(r => r.status === 429);
  assert.ok(ok >= 40 && ok <= 50, `${ok} of 100 got the file`);
  assert.equal(ok + limited.length, 100);
  assert.equal(limited[0].headers['retry-after'], '1');
  assert.match(limited[0].headers['content-type'], /^text\/plain/);
  assert.match(limited[0].body, /Too many requests/);
  assert.equal(limited[0].headers['x-content-type-options'], 'nosniff', 'the usual headers');
  // the health check is exempt, for GET and HEAD
  assert.equal((await burst(s.port, '/healthz', 100, mine)).every(r => r.status === 200), true);
  assert.equal((await burst(s.port, '/healthz?stats', 10, mine)).every(r => r.status === 200), true);
  // another address has its own budget
  assert.equal((await burst(s.port, '/client.js', 30, { 'X-Forwarded-For': '203.0.113.7' })).every(r => r.status === 200), true);
  // unknown paths and bad requests count too
  assert.ok((await burst(s.port, '/nope.js', 60, mine)).some(r => r.status === 429));
  // WebSocket upgrades have a budget of their own: they are not eaten by the HTTP requests
  const c = await from(s, '198.51.100.9');
  c.send({ t: 'ping', n: 5 });
  assert.equal((await c.next('pong')).n, 5);
  // the bucket refills: a second later requests pass again
  await sleep(1100);
  assert.equal((await burst(s.port, '/client.js', 1, mine))[0].status, 200);
});

test('HTTP: the limit counts the client address (X-Forwarded-For), not the proxy\'s socket', async t => {
  // trustProxy 0: the header is ignored, so every request is the socket address and they share one bucket
  const s = await server(t, { httpRate: { capacity: 5, refillPerSec: 0 }, trustProxy: 0 });
  const res = [];
  for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5', '6.6.6.6', '7.7.7.7']) {
    res.push((await burst(s.port, '/client.js', 1, { 'X-Forwarded-For': ip }))[0].status);
  }
  assert.deepEqual(res, [200, 200, 200, 200, 200, 429, 429]);
});

// ---------- static files from memory ----------

test('static files are served from memory (changes on disk are not picked up) unless cacheStatic is false', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legio-static-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>v1</p>');
  fs.writeFileSync(path.join(dir, 'client.js'), 'v1');
  const cached = await server(t, { publicDir: dir });
  const live = await server(t, { publicDir: dir, cacheStatic: false });
  const text = async (s, p) => { const r = await fetch(s.httpUrl + p); return [r.status, await r.text(), r.headers.get('etag')]; };
  const first = await text(cached, '/client.js');
  assert.deepEqual(first.slice(0, 2), [200, 'v1']);
  assert.match(first[2], /^"[A-Za-z0-9_-]{16,}"$/, 'a strong ETag');
  fs.writeFileSync(path.join(dir, 'client.js'), 'v2');
  fs.writeFileSync(path.join(dir, 'new.js'), 'new');
  fs.rmSync(path.join(dir, 'index.html'));
  assert.deepEqual((await text(cached, '/client.js')).slice(0, 2), [200, 'v1'], 'still the copy read at start-up');
  assert.equal((await text(cached, '/')).at(0), 200, 'a deleted file is still served');
  assert.equal((await text(cached, '/new.js')).at(0), 404, 'a file that appeared later is not known: 404 without looking at the disk');
  assert.deepEqual((await text(live, '/client.js')).slice(0, 2), [200, 'v2']);
  assert.equal((await text(live, '/new.js')).at(0), 200);
  assert.equal((await text(live, '/')).at(0), 404);
});

test('static files: ETag and If-None-Match give 304 without a body; HEAD works; the public files of the repo are all served', async t => {
  const s = await server(t);
  const index = await fetch(`${s.httpUrl}/`);
  const etag = index.headers.get('etag');
  assert.equal(index.status, 200);
  assert.ok(etag && !etag.startsWith('W/'));
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  assert.ok(index.headers.get('content-security-policy'));
  const same = await fetch(`${s.httpUrl}/index.html`, { headers: { 'If-None-Match': etag } });
  assert.equal(same.status, 304);
  assert.equal((await same.text()), '');
  assert.equal(same.headers.get('etag'), etag);
  assert.equal(same.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(`${s.httpUrl}/`, { headers: { 'If-None-Match': `"other", W/${etag}` } })).status, 304);
  assert.equal((await fetch(`${s.httpUrl}/`, { headers: { 'If-None-Match': '*' } })).status, 304);
  assert.equal((await fetch(`${s.httpUrl}/`, { headers: { 'If-None-Match': '"nope"' } })).status, 200);
  assert.equal((await fetch(`${s.httpUrl}/client.js`, { headers: { 'If-None-Match': etag } })).status, 200, 'another file has another tag');
  const head = await fetch(`${s.httpUrl}/client.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 1000);
  const files = fs.readdirSync(new URL('../public', import.meta.url), { withFileTypes: true })
    .filter(e => e.isFile() && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(e.name)).map(e => e.name);
  assert.ok(files.includes('index.html') && files.includes('client.js'));
  for (const name of files) {
    const res = await fetch(`${s.httpUrl}/${name}`);
    assert.equal(res.status, 200, name);
    assert.equal((await res.arrayBuffer()).byteLength, fs.statSync(new URL(`../public/${name}`, import.meta.url)).size, name);
  }
});
