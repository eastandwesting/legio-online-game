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
