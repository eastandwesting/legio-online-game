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

test('maxRooms: at capacity an abandoned room gives way to a new one; a room with a player in it never does', async t => {
  const s = await server(t, { maxRooms: 2, graceMs: 5000 });
  const connections = async n => { for (let i = 0; i < 400 && s.game.stats().connections !== n; i++) await new Promise(r => setTimeout(r, 5)); };
  const [a, b, c] = [await connect(s.wsUrl), await connect(s.wsUrl), await connect(s.wsUrl)];
  a.send({ t: 'create', name: 'A' });
  const roomA = await a.next('room');
  b.send({ t: 'practice', name: 'B' });
  const roomB = await b.next('room');
  c.send({ t: 'create', name: 'C' });
  assert.equal((await c.next('error')).code, 'server_full', 'both rooms have a player in them');

  await b.terminate();                       // B's room is now held for a player who may never return
  await connections(2);
  assert.equal(s.game.stats().rooms, 2);
  c.send({ t: 'create', name: 'C' });
  assert.equal((await c.next('room')).players[0].name, 'C');
  assert.equal(s.game.stats().rooms, 2);
  const back = await connect(s.wsUrl);
  back.send({ t: 'rejoin', code: roomB.code, token: roomB.token });
  assert.equal((await back.next('error')).code, 'rejoin_failed', 'the abandoned room made way');
  back.send({ t: 'create', name: 'D' });
  assert.equal((await back.next('error')).code, 'server_full', 'occupied rooms stay');
  await a.flush();
  assert.ok(!a.msgs.some(m => m.t === 'left'));
  a.send({ t: 'ready' });
  assert.equal((await a.next('room')).code, roomA.code);
});

test('maxRooms: of two abandoned rooms the one without a running game goes first', async t => {
  const s = await server(t, { maxRooms: 2, graceMs: 5000 });
  const connections = async n => { for (let i = 0; i < 400 && s.game.stats().connections !== n; i++) await new Promise(r => setTimeout(r, 5)); };
  const game = await connect(s.wsUrl), lobby = await connect(s.wsUrl);
  game.send({ t: 'practice', name: 'Game' });
  const playing = await game.next('room');
  game.send({ t: 'ready' });
  await game.next('start');
  lobby.send({ t: 'create', name: 'Lobby' });
  const waiting = await lobby.next('room');
  await game.terminate();                    // the running game is abandoned first ...
  await connections(1);
  await lobby.terminate();                   // ... the lobby afterwards
  await connections(0);
  const c = await connect(s.wsUrl);
  c.send({ t: 'create', name: 'C' });
  await c.next('room');
  const r1 = await connect(s.wsUrl), r2 = await connect(s.wsUrl);
  r1.send({ t: 'rejoin', code: waiting.code, token: waiting.token });
  assert.equal((await r1.next('error')).code, 'rejoin_failed', 'the empty lobby was given up');
  r2.send({ t: 'rejoin', code: playing.code, token: playing.token });
  assert.equal((await r2.next('room')).phase, 'battle', 'the game can still be resumed');
});
