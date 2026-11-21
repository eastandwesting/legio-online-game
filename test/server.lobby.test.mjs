// Lobby: create / join / practice / ready / leave, limits on rooms, and the HTTP side of the same port.
import assert from 'node:assert/strict';
import { test, startTestServer, connect, pair } from './harness.mjs';

async function server(t, options) {
  const s = await startTestServer(options);
  t.after(() => s.close());
  return s;
}

test('create: a 4-character code, seat 0, a private token', async t => {
  const s = await server(t);
  const a = await connect(s.wsUrl);
  a.send({ t: 'create', name: 'Ann' });
  const room = await a.next('room');
  assert.match(room.code, /^[A-Z0-9]{4}$/);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.mode, 'battle');
  assert.equal(room.you, 0);
  assert.ok(typeof room.token === 'string' && room.token.length >= 22, 'token carries 16+ random bytes');
  assert.deepEqual(room.players, [{ name: 'Ann', ready: false, bot: false, connected: true }]);
  assert.deepEqual(s.game.stats(), { rooms: 1, connections: 1 });
});

test('create: mode campaign is kept, anything else is a battle room', async t => {
  const s = await server(t);
  const a = await connect(s.wsUrl), b = await connect(s.wsUrl);
  a.send({ t: 'create', name: 'A', mode: 'campaign' });
  b.send({ t: 'create', name: 'B', mode: 'constructor' });
  assert.equal((await a.next('room')).mode, 'campaign');
  assert.equal((await b.next('room')).mode, 'battle');
});

test('join: case-insensitive code, both see each other, tokens stay private', async t => {
  const s = await server(t);
  const a = await connect(s.wsUrl), b = await connect(s.wsUrl);
  a.send({ t: 'create', name: 'Ann' });
  const first = await a.next('room');
  b.send({ t: 'join', code: ` ${first.code.toLowerCase()} `, name: 'Bob' });
  const roomB = await b.next('room');
  const roomA = await a.next(m => m.t === 'room' && m.players.length === 2);
  assert.equal(roomB.you, 1);
  assert.equal(roomA.you, 0);
  assert.deepEqual(roomA.players.map(p => p.name), ['Ann', 'Bob']);
  assert.deepEqual(roomA.players, roomB.players);
  assert.equal(roomA.token, first.token);
  assert.notEqual(roomB.token, roomA.token);
  // no message to A ever contains B's token, and the other way round
  assert.ok(!JSON.stringify(a.msgs).includes(roomB.token));
  assert.ok(!JSON.stringify(b.msgs).includes(roomA.token));
});

test('join: unknown code, malformed code and a full room answer bad_room', async t => {
  const s = await server(t);
  const { code } = await pair(s);
  const c = await connect(s.wsUrl);
  for (const bad of ['ZZZZ', '', 'toolong', '__proto__', code]) {
    c.send({ t: 'join', code: bad, name: 'Cy' });
    const err = await c.next('error');
    assert.equal(err.code, 'bad_room');
    assert.equal(typeof err.msg, 'string');
  }
  // a code of the wrong type is ignored silently
  c.send({ t: 'join', code: 1234, name: 'Cy' });
  c.send({ t: 'join', name: 'Cy' });
  await c.flush();
  assert.deepEqual(c.pending().filter(m => m.t !== 'pong'), []);
  // and the socket can still create its own room
  c.send({ t: 'create', name: 'Cy' });
  assert.equal((await c.next('room')).players[0].name, 'Cy');
});

test('names are sanitised to [A-Za-z0-9_ -], 16 characters, default Commander', async t => {
  const s = await server(t);
  const cases = [
    ['<img src=x onerror=alert(1)>', 'img srcx onerror'],
    ['  Scipio Africanus the Elder  ', 'Scipio Africanus'],
    ['Ünïcödé_ok-1', 'ncd_ok-1'],
    ['', 'Commander'],
    ['<<<>>>', 'Commander'],
    [undefined, 'Commander'],
    [42, 'Commander'],
    [{ toString: 'x' }, 'Commander'],
    [['a'], 'Commander'],
  ];
  for (const [name, want] of cases) {
    const c = await connect(s.wsUrl);
    c.send({ t: 'create', name });
    assert.equal((await c.next('room')).players[0].name, want, `name ${JSON.stringify(name)}`);
    await c.close();
  }
});

test('practice: the second seat is a ready bot and nobody can join', async t => {
  const s = await server(t);
  const a = await connect(s.wsUrl), b = await connect(s.wsUrl);
  a.send({ t: 'practice', name: 'Solo', mode: 'campaign' });
  const room = await a.next('room');
  assert.equal(room.mode, 'campaign');
  assert.equal(room.players.length, 2);
  assert.deepEqual(room.players[1], { name: 'Rival Legate (AI)', ready: true, bot: true, connected: true });
  b.send({ t: 'join', code: room.code, name: 'Bob' });
  assert.equal((await b.next('error')).code, 'bad_room');
});

test('ready: flags are broadcast; one player ready does not start anything', async t => {
  const s = await server(t);
  const { a, b } = await pair(s);
  a.send({ t: 'ready' });
  const ra = await a.next('room'), rb = await b.next('room');
  assert.deepEqual(ra.players.map(p => p.ready), [true, false]);
  assert.deepEqual(rb.players.map(p => p.ready), [true, false]);
  assert.equal(ra.phase, 'lobby');
});

test('a seated socket ignores create, practice, join and rejoin', async t => {
  const s = await server(t);
  const { a, code, roomA } = await pair(s);
  const other = await connect(s.wsUrl);
  other.send({ t: 'create', name: 'Other' });
  const otherRoom = await other.next('room');
  a.send({ t: 'create', name: 'Again' });
  a.send({ t: 'practice', name: 'Again' });
  a.send({ t: 'join', code: otherRoom.code, name: 'Again' });
  a.send({ t: 'rejoin', code, token: roomA.token });
  a.send({ t: 'rejoin', code: otherRoom.code, token: otherRoom.token });
  await a.flush();
  assert.deepEqual(a.pending().filter(m => m.t !== 'pong'), []);
  assert.equal(s.game.stats().rooms, 2);
});

test('maxRooms: create and practice beyond the limit answer server_full', async t => {
  const s = await server(t, { maxRooms: 2 });
  const [a, b, c] = [await connect(s.wsUrl), await connect(s.wsUrl), await connect(s.wsUrl)];
  a.send({ t: 'create', name: 'A' }); await a.next('room');
  b.send({ t: 'practice', name: 'B' }); await b.next('room');
  c.send({ t: 'create', name: 'C' });
  assert.equal((await c.next('error')).code, 'server_full');
  c.send({ t: 'practice', name: 'C' });
  assert.equal((await c.next('error')).code, 'server_full');
  // a room that closes frees a slot
  a.send({ t: 'leave' }); await a.next('left');
  c.send({ t: 'create', name: 'C' });
  assert.equal((await c.next('room')).players[0].name, 'C');
});

test('ping: pong echoes a numeric n and nothing else', async t => {
  const s = await server(t);
  const a = await connect(s.wsUrl);
  a.send({ t: 'ping', n: 7 });
  assert.deepEqual(await a.next('pong'), { t: 'pong', n: 7 });
  a.send({ t: 'ping' });
  assert.deepEqual(await a.next('pong'), { t: 'pong' });
  a.send({ t: 'ping', n: '<b>x</b>' });
  assert.deepEqual(await a.next('pong'), { t: 'pong' });
});

test('leave in the lobby: left reply, the other player moves to seat 0, the socket stays usable', async t => {
  const s = await server(t);
  const { a, b } = await pair(s);
  a.send({ t: 'leave' });
  assert.deepEqual(await a.next('left'), { t: 'left', reason: 'leave' });
  const room = await b.next('room');
  assert.equal(room.you, 0);
  assert.equal(room.phase, 'lobby');
  assert.deepEqual(room.players.map(p => p.name), ['Bob']);
  assert.ok(!b.msgs.some(m => m.t === 'end'), 'no forfeit in the lobby');
  // leaving again (not seated) is answered too, and the socket can start over
  a.send({ t: 'leave' });
  assert.equal((await a.next('left')).reason, 'leave');
  a.send({ t: 'join', code: room.code, name: 'Ann2' });
  assert.equal((await a.next('room')).you, 1);
  // the last human leaving destroys the room
  a.send({ t: 'leave' }); b.send({ t: 'leave' });
  await a.next('left'); await b.next('left');
  assert.equal(s.game.stats().rooms, 0);
});

test('disconnect in the lobby: the seat is held, then removed when the grace period ends', async t => {
  const s = await server(t, { graceMs: 250 });
  const { a, b, code } = await pair(s);
  a.send({ t: 'ready' });
  await b.next(m => m.t === 'room' && m.players[0].ready);
  await a.terminate();
  const peer = await b.next('peer');
  assert.equal(peer.state, 'lost');
  assert.equal(peer.grace, 1);
  const held = await b.next('room');
  assert.equal(held.players.length, 2);
  assert.equal(held.players[0].connected, false);
  assert.equal(held.players[0].grace, 1);
  assert.equal(held.players[0].ready, false, 'a lost seat is not ready any more');
  // ready from the remaining player cannot start a game against an absent opponent
  b.send({ t: 'ready' });
  assert.equal((await b.next('room')).phase, 'lobby');
  // grace over: Bob is alone in seat 0, the room is still joinable
  const after = await b.next(m => m.t === 'room' && m.players.length === 1);
  assert.equal(after.you, 0);
  assert.equal(after.phase, 'lobby');
  assert.ok(!b.msgs.some(m => m.t === 'end' || m.t === 'start'));
  const c = await connect(s.wsUrl);
  c.send({ t: 'join', code, name: 'Cy' });
  assert.equal((await c.next('room')).players.length, 2);
});

test('the last human disconnecting: the room is destroyed after the grace period', async t => {
  const s = await server(t, { graceMs: 60 });
  const a = await connect(s.wsUrl);
  a.send({ t: 'practice', name: 'Solo' });
  const room = await a.next('room');
  await a.terminate();
  assert.equal(s.game.stats().rooms, 1, 'held during the grace period');
  const b = await connect(s.wsUrl);
  for (let i = 0; i < 200 && s.game.stats().rooms; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(s.game.stats().rooms, 0);
  b.send({ t: 'rejoin', code: room.code, token: room.token });
  assert.equal((await b.next('error')).code, 'rejoin_failed');
});

test('http on the same port: health check, stats, index page with a CSP, no traversal', async t => {
  const s = await server(t);
  const a = await connect(s.wsUrl);
  a.send({ t: 'create', name: 'A' }); await a.next('room');
  const health = await fetch(`${s.httpUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  assert.deepEqual(await (await fetch(`${s.httpUrl}/healthz?stats`)).json(), { rooms: 1, connections: 1 });
  const index = await fetch(`${s.httpUrl}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.match(index.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${s.httpUrl}/client.js`)).status, 200);
  assert.equal((await fetch(`${s.httpUrl}/%2e%2e/server.js`)).status, 404);
  assert.equal((await fetch(`${s.httpUrl}/nope.js`)).status, 404);
  assert.equal((await fetch(`${s.httpUrl}/`, { method: 'POST' })).status, 405);
});

// ---- capacity: nobody's room is destroyed by somebody else's create (SPEC 7.2) ----

const until = async (cond, ms = 3000) => {
  for (let i = 0; i < ms / 5 && !cond(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(cond(), 'condition not reached');
};
const answer = c => c.next(m => m.t === 'room' || m.t === 'error').then(m => (m.t === 'error' ? m.code : m.t + ':' + m.phase));
async function rejoinAs(s, room) {
  const c = await connect(s.wsUrl);
  c.send({ t: 'rejoin', code: room.code, token: room.token });
  return { c, answer: await answer(c) };
}

test('maxRooms: a full server never destroys a room whose only player is mid-reload; the newcomer is told server_full', async t => {
  const s = await server(t, { maxRooms: 3, graceMs: 5000 });
  const [a, b] = [await connect(s.wsUrl), await connect(s.wsUrl)];
  a.send({ t: 'create', name: 'A' }); await a.next('room');
  b.send({ t: 'create', name: 'B' }); await b.next('room');
  const victim = await connect(s.wsUrl);
  victim.send({ t: 'practice', name: 'Victim', mode: 'campaign' });
  const room = await victim.next('room');
  victim.send({ t: 'ready' });
  await victim.next('camp');
  await victim.terminate();
  await until(() => s.game.stats().connections === 2);
  const newcomer = await connect(s.wsUrl);
  newcomer.send({ t: 'create', name: 'Newcomer' });
  assert.equal(await answer(newcomer), 'server_full');
  newcomer.send({ t: 'practice', name: 'Newcomer' });
  assert.equal(await answer(newcomer), 'server_full');
  const back = await rejoinAs(s, room);
  assert.equal(back.answer, 'room:campaign', 'the reload is covered by the grace period');
});

test('maxRooms: both players of a running battle drop at once, and a lobby host is away: their rooms survive a full server', async t => {
  const s = await server(t, { maxRooms: 2, graceMs: 5000 });
  const { a, b, code, roomA, roomB } = await pair(s);
  a.send({ t: 'ready' }); b.send({ t: 'ready' });
  await Promise.all([a.next('start'), b.next('start')]);
  await Promise.all([a.terminate(), b.terminate()]);
  await until(() => s.game.stats().connections === 0);
  const host = await connect(s.wsUrl);
  host.send({ t: 'create', name: 'Host' });
  const lobby = await host.next('room');
  await host.terminate();
  await until(() => s.game.stats().connections === 0);
  const newcomer = await connect(s.wsUrl);
  newcomer.send({ t: 'create', name: 'Newcomer' });
  assert.equal(await answer(newcomer), 'server_full');
  assert.equal(s.game.stats().rooms, 2);
  assert.equal((await rejoinAs(s, { code, token: roomA.token })).answer, 'room:battle');
  assert.equal((await rejoinAs(s, { code, token: roomB.token })).answer, 'room:battle');
  assert.equal((await rejoinAs(s, lobby)).answer, 'room:lobby');
});

test('an address keeps at most 4 abandoned rooms: the fifth create gives up its own oldest, nobody else\'s', async t => {
  // trustProxy 1: the single X-Forwarded-For entry is the client address, so one test process can be many addresses
  const s = await server(t, { maxRooms: 50, trustProxy: 1, graceMs: 20000 });
  const from = ip => connect(s.wsUrl, { headers: { 'X-Forwarded-For': ip } });
  const other = await from('203.0.113.50');
  other.send({ t: 'practice', name: 'Other' });
  const othersRoom = await other.next('room');
  await other.terminate();
  await until(() => s.game.stats().connections === 0);
  const mine = [];
  for (let i = 0; i < 5; i++) {
    const c = await from('198.51.100.9');
    c.send({ t: 'create', name: 'M' + i });
    mine.push(await c.next('room'));
    await c.terminate();
    await until(() => s.game.stats().connections === 0);
    if (i < 4) for (const room of mine) assert.ok(s.game._rooms.has(room.code), `room ${i} not touched below the quota`);
  }
  assert.equal(s.game._rooms.has(mine[0].code), false, 'the oldest abandoned room of that address went');
  for (const room of [...mine.slice(1), othersRoom]) assert.ok(s.game._rooms.has(room.code));
  assert.equal(s.game.stats().rooms, 5);
  assert.equal((await rejoinAs(s, mine[0])).answer, 'rejoin_failed');
  assert.equal((await rejoinAs(s, mine[4])).answer, 'room:lobby');
  assert.equal((await rejoinAs(s, othersRoom)).answer, 'room:lobby');
});

test('one address cannot fill the room table or push out another address\'s game by creating and hanging up', async t => {
  const s = await server(t, { maxRooms: 30, trustProxy: 1, graceMs: 20000, maxPerIp: 50 });
  const from = ip => connect(s.wsUrl, { headers: { 'X-Forwarded-For': ip } });
  const victim = await from('203.0.113.1');
  victim.send({ t: 'practice', name: 'Victim', mode: 'campaign' });
  const room = await victim.next('room');
  victim.send({ t: 'ready' });
  await victim.next('camp');
  let most = 0;
  const attack = async cycles => {
    for (let i = 0; i < cycles; i++) {
      const c = await from('198.51.100.9');
      c.send({ t: 'practice', name: 'Attacker' });
      await c.next('room');
      c.send({ t: 'ready' });
      await c.next('start');
      most = Math.max(most, s.game.stats().rooms);
      await c.terminate();
      await until(() => s.game.stats().connections === (victim.ws.readyState === 1 ? 1 : 0));
    }
  };
  await attack(40);
  assert.ok(most <= 1 + 4 + 1, `the table held ${most} rooms: the victim, 4 abandoned, 1 open`);
  await victim.terminate();                         // the victim's reload begins
  await until(() => s.game.stats().connections === 0);
  await attack(40);
  assert.ok(s.game._rooms.has(room.code), 'the victim\'s room was not given up');
  assert.equal((await rejoinAs(s, room)).answer, 'room:campaign');
  // and the table is not full for anybody else
  const third = await from('192.0.2.77');
  third.send({ t: 'create', name: 'Third' });
  assert.equal((await third.next(m => m.t === 'room' || m.t === 'error')).t, 'room');
});

test('join: after 8 misses in a minute an address is answered "rate" without a lookup, until the window clears', async t => {
  const s = await server(t, { trustProxy: 1, joinWindowMs: 600 });
  const from = ip => connect(s.wsUrl, { headers: { 'X-Forwarded-For': ip } });
  const host = await from('203.0.113.1');
  host.send({ t: 'create', name: 'Host' });
  const { code } = await host.next('room');
  const guesser = await from('198.51.100.9'), second = await from('198.51.100.9');
  for (let i = 0; i < 8; i++) {
    guesser.send({ t: 'join', code: 'ZZZ' + i, name: 'G' });
    assert.equal((await guesser.next('error')).code, 'bad_room', `miss ${i + 1}`);
  }
  // blocked: even the right code gets no lookup, from this socket or another socket of the same address
  guesser.send({ t: 'join', code, name: 'G' });
  assert.equal((await guesser.next('error')).code, 'rate');
  second.send({ t: 'join', code, name: 'G2' });
  assert.equal((await second.next('error')).code, 'rate');
  assert.equal(s.game._rooms.get(code).seats.length, 1, 'nobody was seated');
  // another address is not affected
  const friend = await from('203.0.113.2');
  friend.send({ t: 'join', code, name: 'Friend' });
  assert.equal((await friend.next('room')).you, 1);
  // the window clears
  await new Promise(r => setTimeout(r, 700));
  second.send({ t: 'join', code: 'NOPE', name: 'G2' });
  assert.equal((await second.next('error')).code, 'bad_room', 'looked up again');
});

test('join: a player who only mistypes now and then is never throttled', async t => {
  const s = await server(t);
  const host = await connect(s.wsUrl);
  host.send({ t: 'create', name: 'Host' });
  const { code } = await host.next('room');
  const c = await connect(s.wsUrl);
  for (let i = 0; i < 7; i++) {
    c.send({ t: 'join', code: 'QQQ' + i, name: 'C' });
    assert.equal((await c.next('error')).code, 'bad_room');
  }
  c.send({ t: 'join', code, name: 'C' });
  assert.equal((await c.next('room')).you, 1, 'the 8th try, with the right code, gets in');
});
