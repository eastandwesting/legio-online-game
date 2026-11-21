// Hostile and broken input, limits, and fault isolation: nothing a client sends may crash the
// process, disturb another room or leave a room stuck.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test, startTestServer, connect, pair, readyBoth, sleep, marchToBattle } from './harness.mjs';

async function server(t, options) {
  const logs = [];
  const s = await startTestServer({ log: line => logs.push(String(line)), ...options });
  t.after(() => s.close());
  return Object.assign(s, { logs });
}

async function assertHealthy(s) {
  assert.equal(await (await fetch(`${s.httpUrl}/healthz`)).text(), 'ok');
  const c = await connect(s.wsUrl);
  c.send({ t: 'ping', n: 1 });
  assert.deepEqual(await c.next('pong'), { t: 'pong', n: 1 });
  c.send({ t: 'practice', name: 'Health' });
  assert.equal((await c.next('room')).players.length, 2);
  c.send({ t: 'leave' });
  await c.next('left');
  await c.close();
}

const lastSnap = c => c.msgs.filter(m => m.t === 'snap').at(-1);
async function settled(sender, viewer = sender) {
  await sender.flush();
  if (viewer !== sender) await viewer.flush();
  const mark = lastSnap(viewer);
  return viewer.next(m => m.t === 'snap' && m.time >= mark.time + 0.2);
}
const quiet = c => c.pending().filter(m => m.t !== 'pong' && m.t !== 'snap');

// Frames that are not even a well-formed message.
const RAW = [
  '', ' ', 'garbage', '{', 'null', 'true', '0', '"move"', '[]', '[{"t":"ready"}]', '{}', '{"t":null}', '{"t":5}',
  '{"t":["move"]}', '{"t":{"t":"move"}}', '{"t":"__proto__"}', '{"t":"constructor"}', '{"t":"toString"}',
  '{"t":"hasOwnProperty"}', '{"__proto__":{"t":"ready"}}', '\u0000', '{"t":"move"}\n{"t":"move"}',
  '{"t":"move","ids":[1],"x":1e999,"y":5}', '{"t":"move","ids":[1],"x":-1e999,"y":-1e999}',
  '{"t":"move","ids":[1e999],"x":5,"y":5}', '{"t":"move","ids":[1],"x":5,"y":5,"face":1e999}',
  '{"t":"attack","ids":[1],"target":1e999}', '{"t":"attack","ids":[1],"target":-1e999}',
  '{"t":"move","ids":{"length":1,"0":1},"x":5,"y":5}', '{"t":"stop","ids":{"__proto__":[1]}}',
  '{"t":"moves","list":{"__proto__":[[1,2,3]]}}', '{"t":"moves","list":[[1,1e999,3]]}',
  '['.repeat(2000) + ']'.repeat(2000),
  `{"t":"move","ids":[${'1,'.repeat(1500)}1],"x":1,"y":1}`,
];

// Well-formed JSON with wrong types, out-of-range values, or other people's units.
function badBattleOrders(own, enemy) {
  const o = own[0], e = enemy[0];
  return [
    { t: 'move' }, { t: 'move', ids: String(o), x: 1, y: 1 }, { t: 'move', ids: [o + 0.5], x: 1, y: 1 },
    { t: 'move', ids: [null], x: 1, y: 1 }, { t: 'move', ids: [[o]], x: 1, y: 1 }, { t: 'move', ids: [String(o)], x: 1, y: 1 },
    { t: 'move', ids: [o], x: '800', y: 450 }, { t: 'move', ids: [o], x: 800 }, { t: 'move', ids: [o], x: null, y: null },
    { t: 'move', ids: [o], x: {}, y: [] }, { t: 'move', ids: [o], x: NaN, y: NaN }, { t: 'move', ids: [o], x: true, y: false },
    { t: 'move', ids: [o], x: 800, y: 450, face: 'north' }, { t: 'move', ids: [o], x: 800, y: 450, face: {} },
    { t: 'move', ids: [o, 'x'], x: 800, y: 450 }, { t: 'move', ids: [...Array(20).fill(o), o], x: 800, y: 450 },
    { t: 'move', ids: enemy, x: 100, y: 100 }, { t: 'stop', ids: enemy }, { t: 'attack', ids: enemy, target: o },
    { t: 'move', ids: [-1, 0, 99999, 2 ** 53], x: 100, y: 100 },
    { t: 'attack', ids: [o], target: String(e) }, { t: 'attack', ids: [o], target: e + 0.5 }, { t: 'attack', ids: [o], target: null },
    { t: 'attack', ids: [o], target: -1 }, { t: 'attack', ids: [o], target: 99999 }, { t: 'attack', ids: [o], target: [e] },
    { t: 'attack', ids: [o], target: own[1] }, { t: 'attack', ids: [o] }, { t: 'attack', target: e },
    { t: 'moves' }, { t: 'moves', list: 'x' }, { t: 'moves', list: [o, 2, 3] }, { t: 'moves', list: [[o]] },
    { t: 'moves', list: [[o, 2]] }, { t: 'moves', list: [[o, 'a', 2]] }, { t: 'moves', list: [[o, 2, 3, 'f']] },
    { t: 'moves', list: [[o, 2, 3, 4, 5]] }, { t: 'moves', list: [[String(o), 2, 3]] }, { t: 'moves', list: [[e, 100, 100]] },
    { t: 'moves', list: [[o, 800, 450], 'x'] }, { t: 'moves', list: Array(21).fill([o, 800, 450]) },
    { t: 'moves', list: [{ 0: o, 1: 800, 2: 450, length: 3 }] },
    { t: 'stop' }, { t: 'stop', ids: 5 }, { t: 'stop', ids: null },
    { t: 'recruit', prov: 0, type: 'sword' }, { t: 'cmove', army: 1, to: 2 }, { t: 'endturn' }, { t: 'ready' },
    { t: 'create', name: 'x' }, { t: 'practice', name: 'x' }, { t: 'join', code: 'AAAA', name: 'x' },
    { t: 'rejoin', code: {}, token: [] }, { t: 'MOVE', ids: [o], x: 1, y: 1 }, { t: 'move ', ids: [o], x: 1, y: 1 },
  ];
}

test('battle: garbage, wrong types and other people\'s units change nothing', async t => {
  const s = await server(t, { stepsPerTick: 1 });
  const { a, b } = await pair(s);
  await readyBoth(a, b, 'start');
  const first = await a.next('snap');
  const own = first.regs.filter(r => r[1] === 0).map(r => r[0]);
  const enemy = first.regs.filter(r => r[1] === 1).map(r => r[0]);
  const outsider = await connect(s.wsUrl);

  for (const raw of RAW) { a.sendRaw(raw); outsider.sendRaw(raw); }
  for (const m of badBattleOrders(own, enemy)) { a.send(m); if (m.t !== 'create' && m.t !== 'practice') outsider.send(m); }
  a.ws.send(Buffer.from(JSON.stringify({ t: 'move', ids: own, x: 800, y: 450 })));   // a binary frame

  const snap = await settled(a);
  assert.deepEqual(snap.regs.map(r => r.slice(0, 5)), first.regs.map(r => r.slice(0, 5)), 'no regiment moved');
  assert.ok(snap.regs.every(r => r[8] === 'idle'));
  assert.deepEqual(quiet(a), [], 'the sender got no reply');
  await outsider.flush();
  // an unseated socket gets an answer only where a player would be left waiting
  assert.deepEqual([...new Set(quiet(outsider).map(m => `${m.t}:${m.code}`))].sort(), ['error:bad_room', 'error:rejoin_failed']);
  assert.equal(s.game.stats().rooms, 1);

  // huge but finite numbers are legal: clamped to the field, never NaN
  a.send({ t: 'move', ids: [own[0]], x: 1e308, y: -1e308, face: 1e308 });
  a.send({ t: 'moves', list: [[own[1], -1e308, 1e308, -1e308]] });
  const later = await a.next(m => m.t === 'snap' && m.time >= snap.time + 1);
  for (const r of later.regs) {
    assert.ok(r.slice(3, 8).every(Number.isFinite), 'finite numbers');
    assert.ok(r[3] >= 0 && r[3] <= 1600 && r[4] >= 0 && r[4] <= 900, 'inside the field');
  }
  const moved = id => later.regs.find(r => r[0] === id)[8] === 'moving';
  assert.ok(moved(own[0]) && moved(own[1]));
  assert.deepEqual(later.regs.filter(r => r[1] === 1).map(r => r.slice(0, 5)), first.regs.filter(r => r[1] === 1).map(r => r.slice(0, 5)));

  assert.deepEqual(s.logs, [], 'nothing threw');
  await assertHealthy(s);
});

test('campaign: prototype keys, wrong types and other people\'s armies change nothing', async t => {
  const s = await server(t);
  const { a, b } = await pair(s, 'campaign');
  const [camp] = await readyBoth(a, b, 'camp');
  assert.equal(camp.gold, 400);
  const bad = [
    { t: 'recruit' }, { t: 'recruit', prov: '0', type: 'sword' }, { t: 'recruit', prov: 0, type: 5 }, { t: 'recruit', prov: 0 },
    { t: 'recruit', prov: 0, type: 'constructor' }, { t: 'recruit', prov: 0, type: '__proto__' },
    { t: 'recruit', prov: 0, type: 'toString' }, { t: 'recruit', prov: 0, type: 'hasOwnProperty' }, { t: 'recruit', prov: 0, type: '' },
    { t: 'recruit', prov: 0, type: ['sword'] }, { t: 'recruit', prov: -1, type: 'sword' }, { t: 'recruit', prov: 99, type: 'sword' },
    { t: 'recruit', prov: 0.5, type: 'sword' }, { t: 'recruit', prov: null, type: 'sword' }, { t: 'recruit', prov: [0], type: 'sword' },
    { t: 'recruit', prov: 12, type: 'sword' }, { t: 'recruit', prov: 6, type: 'sword' }, { t: 'recruit', prov: 1e308, type: 'sword' },
    { t: 'cmove' }, { t: 'cmove', army: '1', to: 2 }, { t: 'cmove', army: 1, to: '2' }, { t: 'cmove', army: 1, to: 1.5 },
    { t: 'cmove', army: 1, to: 99 }, { t: 'cmove', army: 1, to: -1 }, { t: 'cmove', army: 1, to: 12 }, { t: 'cmove', army: 1 },
    { t: 'cmove', army: 2, to: 10 }, { t: 'cmove', army: 2, to: null }, { t: 'cmove', army: {}, to: [] },
    { t: 'cmove', army: 1e308, to: 2 }, { t: 'cmove', army: 1, to: {} }, { t: 'cmove', army: 1, to: false },
    { t: 'move', ids: [1], x: 1, y: 1 }, { t: 'attack', ids: [1], target: 2 }, { t: 'stop', ids: [1] }, { t: 'ready' },
  ];
  for (const m of bad) a.send(m);
  a.sendRaw('{"t":"cmove","army":1,"to":1e999}');
  a.sendRaw('{"t":"recruit","prov":0,"type":"sword","__proto__":{"prov":12}}');   // well-formed: accepted below
  await a.flush(); await b.flush();
  // exactly one order was valid, so exactly one camp update went out
  const [mine, theirs] = [quiet(a), quiet(b)];
  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 1);
  assert.equal(mine[0].gold, 300);
  assert.equal(mine[0].units, 5);
  assert.deepEqual(mine[0].moves, {});
  assert.equal(theirs[0].gold, 400);
  assert.equal(mine[0].armies.length, 2);
  assert.deepEqual(mine[0].armies[1].units, camp.armies[1].units, 'the enemy army is untouched');
  assert.deepEqual(s.logs, []);
  await assertHealthy(s);
});

test('frames: 4096 bytes is accepted, more closes that connection only (1009)', async t => {
  const s = await server(t);
  const { a } = await pair(s);
  const c = await connect(s.wsUrl);
  const frame = size => { const head = '{"t":"ping","n":4,"pad":"'; return `${head}${'x'.repeat(size - head.length - 2)}"}`; };
  assert.equal(Buffer.byteLength(frame(4096)), 4096);
  c.sendRaw(frame(4096));
  assert.equal((await c.next('pong')).n, 4);
  c.sendRaw(frame(4097));
  assert.equal((await c.closed).code, 1009);
  const d = await connect(s.wsUrl);
  d.sendRaw('x'.repeat(200000));
  assert.equal((await d.closed).code, 1009);
  await a.flush();
  assert.deepEqual(s.logs, []);
  await assertHealthy(s);
});

test('rate limit: messages over budget are dropped, a flood closes the connection (1008)', async t => {
  const s = await server(t, { rate: { capacity: 5, refillPerSec: 0 } });
  const c = await connect(s.wsUrl), other = await connect(s.wsUrl);
  for (let n = 1; n <= 8; n++) c.send({ t: 'ping', n });
  const err = await c.next('error');
  assert.equal(err.code, 'rate');
  assert.deepEqual(c.msgs.filter(m => m.t === 'pong').map(m => m.n), [1, 2, 3, 4, 5]);
  for (let n = 0; n < 250; n++) c.send({ t: 'create', name: 'flood' });
  assert.equal((await c.closed).code, 1008);
  assert.equal(c.msgs.filter(m => m.t === 'pong').length, 5);
  assert.equal(c.msgs.filter(m => m.t === 'error').length, 1, 'one warning, not one per dropped message');
  assert.equal(s.game.stats().rooms, 0, 'dropped messages were not acted on');
  // other connections have their own budget
  other.send({ t: 'ping', n: 9 });
  assert.equal((await other.next('pong')).n, 9);
});

test('maxConnections: further sockets are refused with 1013 until one leaves', async t => {
  const s = await server(t, { maxConnections: 2 });
  const a = await connect(s.wsUrl), b = await connect(s.wsUrl);
  const c = await connect(s.wsUrl);
  assert.equal((await c.closed).code, 1013);
  assert.equal(s.game.stats().connections, 2);
  a.send({ t: 'ping' });
  await a.next('pong');
  await b.close();
  for (let i = 0; i < 200 && s.game.stats().connections > 1; i++) await sleep(5);
  const d = await connect(s.wsUrl);
  d.send({ t: 'ping', n: 2 });
  assert.equal((await d.next('pong')).n, 2);
});

test('a refused connection that never answers the close frame is cut after a second', async t => {
  const s = await server(t, { maxConnections: 0 });
  // a raw socket: it completes the WebSocket handshake and then ignores everything it is sent
  const sock = net.connect(s.port, '127.0.0.1');
  t.after(() => sock.destroy());
  sock.on('error', () => {});
  let received = Buffer.alloc(0);
  sock.on('data', d => { received = Buffer.concat([received, d]); });
  const t0 = Date.now();
  const ended = new Promise(resolve => sock.once('close', () => resolve(Date.now() - t0)));
  sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  const ms = await Promise.race([ended, sleep(3500).then(() => null)]);
  assert.ok(ms !== null, 'the server hung up by itself');
  assert.match(received.toString('latin1'), /^HTTP\/1\.1 101 /, 'the handshake was accepted first');
  // the close frame (opcode 8) with status 1013 = 0x03F5 came before the cut
  assert.ok(received.includes(Buffer.from([0x88, 0x0d, 0x03, 0xf5])), 'told why: 1013');
  assert.ok(ms >= 500, `not before a client could have answered (${ms} ms)`);
  assert.equal(s.game.stats().connections, 0);
});

test('maxPerIp: per address, using X-Forwarded-For only when the proxy is trusted', async t => {
  const direct = await server(t, { maxPerIp: 1, trustProxy: false });
  const a = await connect(direct.wsUrl);
  const forged = await connect(direct.wsUrl, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal((await forged.closed).code, 1013, 'an untrusted header does not buy a second connection');
  a.send({ t: 'ping' });
  await a.next('pong');

  const proxied = await server(t, { maxPerIp: 1, trustProxy: true });
  const from = ip => connect(proxied.wsUrl, { headers: { 'X-Forwarded-For': ip } });
  const p1 = await from('203.0.113.1'), p2 = await from('203.0.113.2, 10.0.0.1');
  p1.send({ t: 'ping' }); p2.send({ t: 'ping' });
  await p1.next('pong'); await p2.next('pong');
  assert.equal((await (await from('203.0.113.1')).closed).code, 1013);
  assert.equal(proxied.game.stats().connections, 2);
});

test('a throwing battle tick ends that game as a draw, logs once, and leaves other rooms alone', async t => {
  const s = await server(t, { stepsPerTick: 1, battleTimeLimit: 4 });
  const one = await pair(s), two = await pair(s);
  await readyBoth(one.a, one.b, 'start');
  await readyBoth(two.a, two.b, 'start');
  await one.a.next('snap'); await two.a.next('snap');
  // fault injection: every access to this room's battle now throws
  s.game._rooms.get(one.code).battle = new Proxy({}, { get() { throw new Error('boom'); } });

  const [endA, endB] = await Promise.all([one.a.next('end'), one.b.next('end')]);
  assert.deepEqual(endA, { t: 'end', winner: -1, reason: 'timeout' });
  assert.deepEqual(endB, endA);
  assert.ok(lastSnap(one.a).time < 3, 'it ended at once, not at the time limit');
  assert.equal((await one.a.next('room')).phase, 'over');
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /room fault.*boom/s);

  // the other room plays on to its own time limit
  const end2 = await two.a.next('end');
  assert.equal(end2.reason, 'timeout');
  assert.equal(lastSnap(two.a).left, 0);
  // and the faulted room is not stuck: a rematch works
  await readyBoth(one.a, one.b, 'start');
  assert.ok((await one.a.next('snap')).regs.length === 18);
  assert.equal(s.logs.length, 1);
  await assertHealthy(s);
});

test('a fault in a campaign timer ends the campaign as a draw instead of leaving it stuck', async t => {
  const s = await server(t, { battleTimeLimit: 0.5, betweenMs: 500 });
  const { a, b, code } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  await marchToBattle(a, b, 6);
  await Promise.all([a.next('end'), b.next('end')]);
  // fault injection during the gap after the battle: the pending result can no longer be applied
  s.game._rooms.get(code).fight = null;
  const [overA, overB] = await Promise.all([a.next(m => m.t === 'camp' && m.winner !== null), b.next(m => m.t === 'camp' && m.winner !== null)]);
  assert.equal(overA.winner, -1);
  assert.equal(overA.phase, 'over');
  assert.equal(overB.winner, -1);
  assert.equal((await a.next('room')).phase, 'over');
  assert.equal(s.logs.length, 1);
  // a new campaign can be started in the same room
  const [fresh] = await readyBoth(a, b, m => m.t === 'camp' && m.winner === null);
  assert.equal(fresh.turn, 1);
  assert.equal(fresh.phase, 'orders');
  await assertHealthy(s);
});

test('a room that cannot be recovered is closed; its players are told and the server lives on', async t => {
  const s = await server(t);
  const { a, b, code } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  s.game._rooms.get(code).camp = new Proxy({}, { get() { throw new Error('rotten'); } });
  a.send({ t: 'endturn' });
  assert.deepEqual(await a.next('left'), { t: 'left', reason: 'closed' });
  assert.deepEqual(await b.next('left'), { t: 'left', reason: 'closed' });
  assert.equal(s.game.stats().rooms, 0);
  // both sockets are free again
  a.send({ t: 'create', name: 'Ann' });
  assert.equal((await a.next('room')).phase, 'lobby');
  await assertHealthy(s);
});

// ---- who counts as the same client (SPEC 7.2) ----

// Opens sockets one by one with the given X-Forwarded-For values; resolves with how many stayed open.
async function openWith(s, values, extra = {}) {
  const sockets = [];
  for (const value of values) sockets.push(await connect(s.wsUrl, { headers: { 'X-Forwarded-For': value, ...extra } }));
  let accepted = 0;
  for (const c of sockets) {
    c.send({ t: 'ping' });
    if (await c.next('pong', 500).then(() => true, () => false)) accepted++;
  }
  return { sockets, accepted };
}

test('behind one proxy only the entry the proxy added counts: forged leading hops buy nothing, nobody is locked out', async t => {
  const s = await server(t, { trustProxy: true, maxPerIp: 20 });
  // 25 sockets, each with another forged first entry in front of the same proxy-added entry
  const forged = await openWith(s, Array.from({ length: 25 }, (_, i) => `10.9.${i}.1, 203.0.113.7`));
  assert.equal(forged.accepted, 20, 'one real client: 20 sockets, whatever it writes in front');
  assert.equal(s.game.stats().connections, 20);
  // a victim whose address the attacker wrote in front is not locked out
  const victim = await openWith(s, ['203.0.113.8']);
  assert.equal(victim.accepted, 1, 'another client is accepted');
  const named = await openWith(s, ['203.0.113.8, 203.0.113.7']);
  assert.equal(named.accepted, 0, 'but the attacker\'s sockets are counted as the attacker, not as the name they wrote');
  // the counter is released when sockets close
  await forged.sockets[0].close();
  for (let i = 0; i < 200 && s.game.stats().connections > 20; i++) await sleep(5);
  assert.equal((await openWith(s, ['1.1.1.1, 203.0.113.7'])).accepted, 1);
});

test('with 2 trusted proxies the entry before the last counts; a header that is too short falls back to the socket address', async t => {
  const s = await server(t, { trustProxy: 2, maxPerIp: 3 });
  const a = await openWith(s, Array.from({ length: 5 }, (_, i) => `9.9.${i}.1, 203.0.113.7, 10.0.0.1`));
  assert.equal(a.accepted, 3, 'the same client behind two proxies');
  const b = await openWith(s, Array.from({ length: 5 }, (_, i) => `9.9.9.9, 203.0.113.${i + 20}, 10.0.0.1`));
  assert.equal(b.accepted, 5, 'different clients behind the same last proxy');
  const c = await openWith(s, ['203.0.113.50', '203.0.113.51', '203.0.113.52', '203.0.113.53']);   // one entry: not enough
  assert.equal(c.accepted, 3, 'all counted as the socket address (127.0.0.1)');
});

test('behind a proxy the default limit per address is 40, direct it is 20', async t => {
  const proxied = await server(t, { trustProxy: 1 });
  assert.equal((await openWith(proxied, Array.from({ length: 42 }, () => '203.0.113.7'))).accepted, 40);
  const direct = await server(t, { trustProxy: false });
  assert.equal((await openWith(direct, Array.from({ length: 22 }, () => '203.0.113.7'))).accepted, 20);
});

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('environment: TRUST_PROXY_HOPS, MAX_ROOMS, MAX_CONNECTIONS and MAX_PER_IP set the defaults; options and bad values', async t => {
  const hostile = Array.from({ length: 8 }, (_, i) => `10.9.${i}.1, 203.0.113.7`);
  // 1 hop (the Render default): all forged entries are one client
  await withEnv({ RENDER: 'true', TRUST_PROXY_HOPS: undefined, MAX_PER_IP: '5' }, async () => {
    assert.equal((await openWith(await server(t), hostile)).accepted, 5);
  });
  // no variable and no RENDER: the header is ignored, all sockets share the socket address
  await withEnv({ RENDER: undefined, TRUST_PROXY_HOPS: undefined, MAX_PER_IP: '5' }, async () => {
    assert.equal((await openWith(await server(t), hostile)).accepted, 5);
    assert.equal((await openWith(await server(t), [...hostile, ...hostile].map((_, i) => `10.9.${i}.1`))).accepted, 5);
  });
  // TRUST_PROXY_HOPS=0 beats RENDER; =2 counts the second entry from the right
  await withEnv({ RENDER: 'true', TRUST_PROXY_HOPS: '0', MAX_PER_IP: '3' }, async () => {
    const s = await server(t);
    assert.equal((await openWith(s, Array.from({ length: 5 }, (_, i) => `10.9.${i}.1, 203.0.113.${i}`))).accepted, 3);
  });
  await withEnv({ RENDER: undefined, TRUST_PROXY_HOPS: '2', MAX_PER_IP: '3' }, async () => {
    const s = await server(t);
    assert.equal((await openWith(s, Array.from({ length: 5 }, (_, i) => `10.9.${i}.1, 203.0.113.${i}, 10.0.0.1`))).accepted, 5);
  });
  // MAX_ROOMS and MAX_CONNECTIONS
  await withEnv({ MAX_ROOMS: '2', MAX_CONNECTIONS: '3', RENDER: undefined, TRUST_PROXY_HOPS: undefined, MAX_PER_IP: undefined }, async () => {
    const s = await server(t);
    const [a, b, c] = [await connect(s.wsUrl), await connect(s.wsUrl), await connect(s.wsUrl)];
    a.send({ t: 'create', name: 'A' }); await a.next('room');
    b.send({ t: 'create', name: 'B' }); await b.next('room');
    c.send({ t: 'create', name: 'C' });
    assert.equal((await c.next('error')).code, 'server_full', 'MAX_ROOMS');
    assert.equal((await (await connect(s.wsUrl)).closed).code, 1013, 'MAX_CONNECTIONS');
  });
  // options win over the environment; invalid values are ignored
  await withEnv({ MAX_ROOMS: '2', MAX_PER_IP: '0', MAX_CONNECTIONS: 'lots', TRUST_PROXY_HOPS: 'many', RENDER: undefined }, async () => {
    const s = await server(t, { maxRooms: 3 });
    const cs = [];
    for (let i = 0; i < 4; i++) { const c = await connect(s.wsUrl); c.send({ t: 'create', name: 'N' + i }); cs.push(await c.next(m => m.t === 'room' || m.t === 'error')); }
    assert.deepEqual(cs.map(m => m.t), ['room', 'room', 'room', 'error'], 'the option 3, not MAX_ROOMS 2');
    assert.equal((await openWith(await server(t), Array.from({ length: 22 }, () => '1.2.3.4'))).accepted, 20, 'bad values: the defaults');
  });
});

test('the first proxied connection is logged once with the header and what it was counted as', async t => {
  const s = await server(t, { trustProxy: 1 });
  await openWith(s, ['203.0.113.7', '203.0.113.8']);
  const notes = s.logs.filter(l => l.includes('proxy check'));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /X-Forwarded-For "203\.0\.113\.7".*1 trusted hop\(s\), counted as client 203\.0\.113\.7/);
  const bare = await server(t, { trustProxy: false });
  await openWith(bare, ['203.0.113.7 <b>' + 'x'.repeat(400), '2.2.2.2']);
  const warns = bare.logs.filter(l => l.includes('TRUST_PROXY_HOPS is 0'));
  assert.equal(warns.length, 1);
  assert.ok(warns[0].length < 500, 'a long header is cut');
  const quiet = await server(t, { trustProxy: 1 });
  const c = await connect(quiet.wsUrl);
  c.send({ t: 'ping' }); await c.next('pong');
  assert.deepEqual(quiet.logs, [], 'nothing without the header');
});

// ---- sockets that join no room (SPEC 7.2) ----

test('sockets in no room are closed after unseatedIdleMs; pings do not count, seated sockets are left alone', async t => {
  const s = await server(t, { unseatedIdleMs: 250, heartbeatMs: 60000, idleRoomMs: 60000, graceMs: 5000 });
  const silent = await connect(s.wsUrl);
  const pinger = await connect(s.wsUrl);
  const chatty = await connect(s.wsUrl);
  const seated = await connect(s.wsUrl);
  const playing = await connect(s.wsUrl);
  seated.send({ t: 'create', name: 'Seated' });
  const lobby = await seated.next('room');
  playing.send({ t: 'practice', name: 'Playing' });
  await playing.next('room');
  playing.send({ t: 'ready' });
  await playing.next('start');
  const timer = setInterval(() => {
    pinger.ws.readyState === 1 && pinger.send({ t: 'ping' });
    chatty.ws.readyState === 1 && chatty.send({ t: 'join', code: 'NOPE', name: 'x' });
  }, 40);
  t.after(() => clearInterval(timer));
  const t0 = Date.now();
  const [a, b] = await Promise.all([silent.closed, pinger.closed]);
  assert.deepEqual([a.code, a.reason, b.code, b.reason], [1008, 'Idle', 1008, 'Idle']);
  const took = Date.now() - t0;
  assert.ok(took < 1500, `closed after ${took} ms`);
  assert.equal(chatty.ws.readyState, 1, 'a socket that says something is not idle');
  assert.equal(seated.ws.readyState, 1, 'a seated socket is the room\'s business');
  assert.equal(playing.ws.readyState, 1, 'and so is one in a running game');
  for (let i = 0; i < 200 && s.game.stats().connections > 3; i++) await sleep(5);
  assert.equal(s.game.stats().connections, 3);
  // leaving a room starts the clock again
  seated.send({ t: 'leave' });
  await seated.next('left');
  assert.equal((await seated.closed).code, 1008);
  assert.ok(lobby.code);
  clearInterval(timer);
  await Promise.all([chatty.close(), playing.close()]);
});

test('a flood of silent sockets does not hold the server: the slots come back and a new player gets in', async t => {
  const s = await server(t, { maxConnections: 12, maxPerIp: 100, trustProxy: 1, unseatedIdleMs: 200, heartbeatMs: 60000 });
  const hold = await openWith(s, Array.from({ length: 12 }, (_, i) => `203.0.113.${i + 1}`));
  assert.equal(hold.accepted, 12);
  assert.equal((await (await connect(s.wsUrl, { headers: { 'X-Forwarded-For': '198.51.100.1' } })).closed).code, 1013, 'full');
  await Promise.all(hold.sockets.map(c => c.closed));
  for (let i = 0; i < 400 && s.game.stats().connections > 0; i++) await sleep(5);
  const fresh = await connect(s.wsUrl, { headers: { 'X-Forwarded-For': '198.51.100.1' } });
  fresh.send({ t: 'ping', n: 3 });
  assert.equal((await fresh.next('pong')).n, 3, 'no 1013 any more');
});

// ---- limits that the suite used to take on trust ----

test('a client that stopped reading gets no more snapshots, and is dropped when its backlog grows', async t => {
  const s = await server(t, { stepsPerTick: 1, graceMs: 5000 });
  const { a, b } = await pair(s);
  await readyBoth(a, b, 'start');
  await a.next('snap');
  const theirs = [...s.game._conns].find(ws => ws.seat && ws.seat.name === 'Bob');
  assert.ok(theirs);
  let backlog = 100 * 1024;                       // above SNAP_SKIP_BYTES (64 KiB), below MAX_BUFFERED (1 MiB)
  Object.defineProperty(theirs, 'bufferedAmount', { get: () => backlog });
  await b.flush().catch(() => {});
  const seen = b.msgs.filter(m => m.t === 'snap').length;
  const t0 = lastSnap(a).time;
  await a.next(m => m.t === 'snap' && m.time >= t0 + 1);
  assert.ok(b.msgs.filter(m => m.t === 'snap').length <= seen + 3, 'snapshots are skipped for a client this far behind');
  assert.equal(b.ws.readyState, 1, 'but it is not dropped yet');
  backlog = 2 * 1024 * 1024;                      // beyond MAX_BUFFERED: the next message to it ends the connection
  b.send({ t: 'ping' });
  assert.equal((await b.closed).code, 1006, 'terminated by the server');
  assert.equal((await a.next('peer')).state, 'lost');
});

test('an order frame names at most 20 regiments: 20 are obeyed, 21 are ignored whole', async t => {
  const s = await server(t, { stepsPerTick: 1 });
  const { a, b, code } = await pair(s);
  await readyBoth(a, b, 'start');
  const battle = s.game._rooms.get(code).battle;
  const mine = battle.regs.filter(r => r.owner === 0).map(r => r.id);
  const pad = n => Array.from({ length: n }, (_, i) => 1000 + i);
  a.send({ t: 'move', ids: [...mine, ...pad(12)], x: 800, y: 450 });          // 21 ids
  await a.flush();
  assert.ok(battle.regs.filter(r => r.owner === 0).every(r => r.order === null), '21 ids: nothing happens');
  a.send({ t: 'move', ids: [...mine, ...pad(11)], x: 800, y: 450 });          // 20 ids
  await a.flush();
  assert.ok(battle.regs.filter(r => r.owner === 0).every(r => r.order && r.order.t === 'move'), '20 ids: obeyed');
});
