// Seats, tokens, grace, rejoin and pause (SPEC 7.3), plus heartbeat and idle-room expiry.
import assert from 'node:assert/strict';
import { test, startTestServer, connect, pair, readyBoth, sleep, attackNearest } from './harness.mjs';

async function server(t, options) {
  const logs = [];
  const s = await startTestServer({ log: line => logs.push(String(line)), ...options });
  t.after(() => s.close());
  return Object.assign(s, { logs });
}

const lastSnap = c => c.msgs.filter(m => m.t === 'snap').at(-1);
const rejoin = async (s, code, token) => {
  const c = await connect(s.wsUrl);
  c.send({ t: 'rejoin', code, token });
  return c;
};

test('disconnect in a battle: pause with the sim frozen, rejoin with a full sync, resume', async t => {
  const s = await server(t, { stepsPerTick: 1, graceMs: 5000, resumeDelayMs: 400 });
  const { a, b, code, roomA } = await pair(s);
  await readyBoth(a, b, 'start');
  const first = await a.next(m => m.t === 'snap' && m.time >= 0.3);
  const mover = first.regs.find(r => r[1] === 0)[0], idler = first.regs.find(r => r[1] === 1)[0];
  a.send({ t: 'move', ids: [mover], x: 800, y: 450 });   // an order given before the drop stays in force
  await a.flush();
  await a.terminate();

  assert.deepEqual(await b.next('peer'), { t: 'peer', state: 'lost', grace: 5 });
  const held = await b.next('room');
  assert.equal(held.phase, 'battle');
  assert.deepEqual(held.players[0], { name: 'Ann', ready: true, bot: false, connected: false, grace: 5 });
  const frozen = lastSnap(b);
  b.send({ t: 'move', ids: [idler], x: 800, y: 450 });   // orders are not taken while the game is paused
  await sleep(150);
  await b.flush();
  assert.equal(lastSnap(b), frozen, 'no snapshot while paused');

  const a2 = await rejoin(s, code.toLowerCase(), roomA.token);
  const sync = [await a2.next(), await a2.next(), await a2.next()];
  assert.deepEqual(sync.map(m => m.t), ['room', 'start', 'snap']);
  assert.equal(sync[0].you, 0);
  assert.equal(sync[0].token, roomA.token);
  assert.equal(sync[0].phase, 'battle');
  assert.deepEqual(sync[0].players.map(p => p.connected), [true, true]);
  assert.equal(sync[1].you, 0);
  assert.equal(sync[1].limit, 300);
  assert.deepEqual(sync[2], frozen, 'the sim did not advance while paused');

  assert.deepEqual(await b.next('peer'), { t: 'peer', state: 'back' });
  assert.deepEqual((await b.next('room')).players.map(p => p.connected), [true, true]);
  // the game stays paused for the resume delay, so the returning player can find their feet
  await sleep(120);
  await b.flush();
  assert.equal(lastSnap(b), frozen, 'still paused during the resume delay');
  // then snapshots resume for both, from where the battle stopped
  const [nextA, nextB] = await Promise.all([a2.next('snap'), b.next('snap')]);
  assert.deepEqual(nextA, nextB);
  assert.ok(nextA.time >= frozen.time && nextA.time <= frozen.time + 0.2, 'no jump in sim time');
  const later = await b.next(m => m.t === 'snap' && m.time >= frozen.time + 1);
  const x = (snap, id) => snap.regs.find(r => r[0] === id)[3];
  assert.ok(x(later, mover) > x(frozen, mover) + 20, 'the order from before the drop is still carried out');
  assert.equal(x(later, idler), x(first, idler), 'the order sent during the pause was ignored');
  assert.deepEqual(s.logs, []);
});

test('grace expiry in a battle: the other player wins by forfeit and waits in the lobby as seat 0', async t => {
  const s = await server(t, { graceMs: 150 });
  const { a, b, code, roomA } = await pair(s);
  await readyBoth(a, b, 'start');
  await a.terminate();
  assert.equal((await b.next('peer')).state, 'lost');
  assert.deepEqual(await b.next('end'), { t: 'end', winner: 1, reason: 'forfeit', forfeit: true });
  const room = await b.next('room');
  assert.equal(room.phase, 'lobby');
  assert.equal(room.you, 0);
  assert.deepEqual(room.players, [{ name: 'Bob', ready: false, bot: false, connected: true }]);
  // the seat is gone for good
  const late = await rejoin(s, code, roomA.token);
  assert.deepEqual(await late.next('error'), { t: 'error', code: 'rejoin_failed', msg: 'That game is no longer available.' });
  // no ghost of the old battle
  await sleep(100);
  await b.flush();
  assert.deepEqual(b.pending().filter(m => m.t !== 'pong'), []);
  // and the room works: a new opponent joins and a new battle starts
  late.send({ t: 'join', code, name: 'Cy' });
  await late.next('room');
  await readyBoth(b, late, 'start');
  assert.ok((await b.next('snap')).time < 2);
});

test('rejoin: a wrong token, a wrong code, the bot seat and garbage all fail and change nothing', async t => {
  const s = await server(t, { graceMs: 5000 });
  const { a, b, code, roomA, roomB } = await pair(s);
  await readyBoth(a, b, 'start');
  await a.terminate();
  await b.next('peer');
  const c = await connect(s.wsUrl);
  const tries = [
    { code, token: roomA.token.slice(0, -1) + (roomA.token.endsWith('A') ? 'B' : 'A') },
    { code, token: roomA.token + 'x' }, { code, token: '' }, { code, token: null }, { code, token: 'null' },
    { code, token: undefined }, { code, token: [roomA.token] }, { code, token: { toString: 1 } },
    { code: 'ZZZZ', token: roomA.token }, { code: null, token: roomA.token }, { token: roomA.token }, {},
    { code: '__proto__', token: '__proto__' },
  ];
  for (const fields of tries) {
    c.send({ t: 'rejoin', ...fields });
    assert.equal((await c.next('error')).code, 'rejoin_failed', JSON.stringify(fields));
  }
  await b.flush();
  assert.ok(!b.pending().some(m => m.t === 'peer'), 'nobody came back');
  // the right token still works, also on the socket that just failed
  c.send({ t: 'rejoin', code, token: roomA.token });
  assert.equal((await c.next('room')).you, 0);
  assert.equal((await b.next('peer')).state, 'back');
  assert.notEqual(roomA.token, roomB.token);

  // a practice room: the bot seat has no token to guess
  const p = await connect(s.wsUrl);
  p.send({ t: 'practice', name: 'Solo' });
  const practice = await p.next('room');
  const thief = await connect(s.wsUrl);
  for (const token of [null, 'null', '', 'undefined']) {
    thief.send({ t: 'rejoin', code: practice.code, token });
    assert.equal((await thief.next('error')).code, 'rejoin_failed');
  }
});

test('explicit leave during a battle forfeits; the leaver can play elsewhere at once', async t => {
  const s = await server(t);
  const { a, b } = await pair(s);
  await readyBoth(a, b, 'start');
  b.send({ t: 'leave' });
  assert.deepEqual(await b.next('left'), { t: 'left', reason: 'leave' });
  assert.deepEqual(await a.next('end'), { t: 'end', winner: 0, reason: 'forfeit', forfeit: true });
  const room = await a.next('room');
  assert.equal(room.phase, 'lobby');
  assert.equal(room.players.length, 1);
  await b.flush();
  assert.deepEqual(b.pending().filter(m => m.t !== 'pong'), [], 'nothing from the old room reaches the leaver');
  b.send({ t: 'practice', name: 'Bob' });
  assert.equal((await b.next('room')).players.length, 2);
  await sleep(60);
  await a.flush();
  assert.ok(!a.pending().some(m => m.t === 'snap' || m.t === 'start'), 'the battle is gone');
});

test('leaving a practice game destroys the room', async t => {
  const s = await server(t);
  const a = await connect(s.wsUrl);
  a.send({ t: 'practice', name: 'Solo' });
  await a.next('room');
  a.send({ t: 'ready' });
  await a.next('snap');
  a.send({ t: 'leave' });
  await a.next('left');
  assert.equal(s.game.stats().rooms, 0);
  await sleep(60);
  await a.flush();
  assert.ok(!a.pending().some(m => m.t === 'snap'));
});

test('rejoin while the old socket is still open: the old one is closed with 4000, nothing pauses', async t => {
  const s = await server(t, { stepsPerTick: 1 });
  const { a, b, code, roomA } = await pair(s);
  await readyBoth(a, b, 'start');
  await b.next('snap');
  const a2 = await rejoin(s, code, roomA.token);
  assert.equal((await a.closed).code, 4000);
  assert.deepEqual([(await a2.next()).t, (await a2.next()).t, (await a2.next()).t], ['room', 'start', 'snap']);
  const room = await b.next('room');
  assert.deepEqual(room.players.map(p => p.connected), [true, true]);
  const t0 = lastSnap(b).time;
  await b.next(m => m.t === 'snap' && m.time >= t0 + 1);
  assert.ok(!b.msgs.some(m => m.t === 'peer'), 'the seat was never lost');
  assert.equal(s.game.stats().connections, 2);
});

test('reload in the lobby and after a game: the seat survives, ready is reset', async t => {
  const s = await server(t, { battleTimeLimit: 0.5, graceMs: 5000 });
  const { a, b, code, roomA } = await pair(s);
  a.send({ t: 'ready' });
  await b.next(m => m.t === 'room' && m.players[0].ready);
  await a.terminate();
  await b.next('peer');
  const a2 = await rejoin(s, code, roomA.token);
  const room = await a2.next('room');
  assert.equal(room.phase, 'lobby');
  assert.deepEqual(room.players.map(p => [p.name, p.ready, p.connected]), [['Ann', false, true], ['Bob', false, true]]);
  assert.equal((await b.next('peer')).state, 'back');
  // play a short battle, then reload on the result screen
  await readyBoth(a2, b, 'end');
  await a2.next(m => m.t === 'room' && m.phase === 'over');
  await a2.terminate();
  const a3 = await rejoin(s, code, roomA.token);
  const over = await a3.next('room');
  assert.equal(over.phase, 'over');
  // the page that reloads on the result screen has lost the result: it is sent again (once), after the room
  assert.deepEqual(await a3.next('end'), { t: 'end', winner: -1, reason: 'timeout' });
  await a3.flush();
  assert.deepEqual(a3.pending().filter(m => m.t !== 'pong'), [], 'no start or camp for a finished game');
  // rematch from the reloaded page
  await readyBoth(a3, b, 'start');
});

test('both players drop: the one who returns after the other forfeited is told so', async t => {
  const s = await server(t, { graceMs: 800 });
  const { a, b, code, roomB } = await pair(s);
  await readyBoth(a, b, 'start');
  await a.terminate();
  await b.next('peer');
  await sleep(600);
  await b.terminate();
  const room = s.game._rooms.get(code);
  for (let i = 0; i < 200 && room.phase !== 'lobby'; i++) await sleep(10);   // Ann's grace runs out first
  assert.equal(room.phase, 'lobby');
  const b2 = await rejoin(s, code, roomB.token);
  const now = await b2.next('room');
  assert.equal(now.phase, 'lobby');
  assert.equal(now.you, 0);
  assert.deepEqual(await b2.next('end'), { t: 'end', winner: 0, reason: 'forfeit', forfeit: true });
  // Bob's own grace timer was cancelled by the rejoin
  await sleep(900);
  assert.equal(s.game.stats().rooms, 1);
  b2.send({ t: 'ping' });
  await b2.next('pong');
});

test('a second drop during the resume delay keeps the game paused', async t => {
  const s = await server(t, { stepsPerTick: 1, graceMs: 5000, resumeDelayMs: 400 });
  const { a, b, code, roomA } = await pair(s);
  await readyBoth(a, b, 'start');
  await b.next(m => m.t === 'snap' && m.time >= 0.2);
  await a.terminate();
  await b.next('peer');
  const frozen = lastSnap(b);
  const a2 = await rejoin(s, code, roomA.token);
  await a2.next('snap');
  await a2.terminate();                      // gone again before the 400 ms resume delay is over
  assert.equal((await b.next(m => m.t === 'peer' && m.state === 'lost')).grace, 5);
  await sleep(500);
  await b.flush();
  assert.equal(lastSnap(b), frozen, 'still paused');
  const a3 = await rejoin(s, code, roomA.token);
  assert.deepEqual((await a3.next('snap')).regs, frozen.regs);
  await b.next(m => m.t === 'snap' && m.time >= frozen.time + 0.5);
});

test('heartbeat: a socket that stops answering pings is terminated and its seat held', async t => {
  const s = await server(t, { heartbeatMs: 100, graceMs: 5000 });
  const dead = await connect(s.wsUrl, { autoPong: false });
  const b = await connect(s.wsUrl);
  dead.send({ t: 'create', name: 'Ghost' });
  const { code } = await dead.next('room');
  b.send({ t: 'join', code, name: 'Bob' });
  await b.next('room');
  assert.equal((await dead.closed).code, 1006, 'cut without a close handshake');
  assert.equal((await b.next('peer')).state, 'lost');
  assert.equal((await b.next('room')).players[0].connected, false);
  // a socket that does answer lives through several heartbeats
  await sleep(450);
  b.send({ t: 'ping', n: 3 });
  assert.equal((await b.next('pong')).n, 3);
  assert.equal(s.game.stats().connections, 1);
});

test('idle rooms are closed with left/idle; pings do not count as activity, other messages do', async t => {
  const s = await server(t, { idleRoomMs: 300 });
  const { a, b } = await pair(s);
  const busy = await connect(s.wsUrl);
  busy.send({ t: 'create', name: 'Busy' });
  await busy.next('room');
  const timer = setInterval(() => {
    a.send({ t: 'ping' }); b.send({ t: 'ping' });
    busy.send({ t: 'stop', ids: [] });   // ignored in the lobby, but it is a sign of life
  }, 20);
  t.after(() => clearInterval(timer));
  assert.deepEqual(await a.next('left'), { t: 'left', reason: 'idle' });
  assert.deepEqual(await b.next('left'), { t: 'left', reason: 'idle' });
  await sleep(400);
  assert.equal(s.game.stats().rooms, 1, 'the active room is still there');
  assert.ok(!busy.msgs.some(m => m.t === 'left'));
  clearInterval(timer);
  // the sockets of the closed room are free to start over
  a.send({ t: 'create', name: 'Ann' });
  assert.equal((await a.next('room')).phase, 'lobby');
  assert.equal((await busy.next('left')).reason, 'idle');
});

// One drop and return of seat 0; resolves with the grace (whole seconds) announced to the other player.
async function dropAndReturn(s, b, client, code, token, awayMs) {
  await client.terminate();
  const lost = await b.next(m => m.t === 'peer' && m.state === 'lost');
  await sleep(awayMs);
  const next = await rejoin(s, code, token);
  await next.next('room');
  await b.next(m => m.t === 'peer' && m.state === 'back');
  return { grace: lost.grace, client: next };
}

test('grace is an allowance: time away is spent, so dropping again and again cannot freeze a game', async t => {
  const s = await server(t, { graceMs: 3000, graceRefill: 0, resumeDelayMs: 5 });
  const { a, b, code, roomA } = await pair(s);
  await readyBoth(a, b, 'start');
  const first = await dropAndReturn(s, b, a, code, roomA.token, 1100);
  assert.equal(first.grace, 3, 'a full allowance the first time');
  const second = await dropAndReturn(s, b, first.client, code, roomA.token, 1100);
  assert.equal(second.grace, 2, 'the first absence was spent');
  await second.client.terminate();
  const third = await b.next(m => m.t === 'peer' && m.state === 'lost');
  assert.ok(third.grace <= 1, `under a second is left, got ${third.grace}`);
  // the rest runs out long before a fresh 3 s would
  assert.deepEqual(await b.next('end', 2000), { t: 'end', winner: 1, reason: 'forfeit', forfeit: true });
  assert.equal((await b.next('room')).phase, 'lobby');
  const late = await rejoin(s, code, roomA.token);
  assert.equal((await late.next('error')).code, 'rejoin_failed');
  assert.deepEqual(s.logs, []);
});

test('grace refills while the seat is connected, never beyond graceMs', async t => {
  const s = await server(t, { graceMs: 2000, graceRefill: 4, resumeDelayMs: 5 });
  const { a, b, code, roomA } = await pair(s);
  await readyBoth(a, b, 'start');
  const first = await dropAndReturn(s, b, a, code, roomA.token, 1100);
  assert.equal(first.grace, 2);
  // under 0.9 s is left now; 0.4 s connected earns back 1.6 s, capped at the full 2 s
  await sleep(400);
  await first.client.terminate();
  assert.equal((await b.next(m => m.t === 'peer' && m.state === 'lost')).grace, 2);
  const again = await rejoin(s, code, roomA.token);
  assert.equal((await again.next('room')).phase, 'battle');
  // a replaced socket (reload with the old tab still open) costs nothing
  const tab = await rejoin(s, code, roomA.token);
  assert.equal((await tab.next('room')).you, 0);
  assert.equal((await again.closed).code, 4000);
  assert.deepEqual(s.logs, []);
});

test('outside a game nobody is kept waiting: every drop gets the full graceMs and costs nothing', async t => {
  const s = await server(t, { graceMs: 3000, graceRefill: 0, resumeDelayMs: 5 });
  const { a, b, code, roomA } = await pair(s);
  const first = await dropAndReturn(s, b, a, code, roomA.token, 1100);
  const second = await dropAndReturn(s, b, first.client, code, roomA.token, 1100);
  assert.deepEqual([first.grace, second.grace], [3, 3], 'in the lobby');
  // the allowance is untouched when a game starts
  await readyBoth(second.client, b, 'start');
  const third = await dropAndReturn(s, b, second.client, code, roomA.token, 20);
  assert.equal(third.grace, 3);
  assert.deepEqual(s.logs, []);
});

test('dropping for an instant again and again is paid for with the resume delay: no free freeze', async t => {
  const s = await server(t, { graceMs: 2000, resumeDelayMs: 400, stepsPerTick: 1 });
  const { a, b, code, roomB } = await pair(s);
  await readyBoth(a, b, 'start');
  // Seat 1 drops and returns at once, never staying for the resume delay: the game stays frozen,
  // but every round costs 400 ms of a 2 s allowance and earns nothing back.
  let griefer = b, rounds = 0, refused = null;
  while (!refused && rounds < 40) {
    await griefer.terminate();
    await a.next(m => m.t === 'peer' && m.state === 'lost');   // the server has noticed the drop
    griefer = await rejoin(s, code, roomB.token);
    const m = await griefer.next(x => x.t === 'room' || x.t === 'error');
    if (m.t === 'error') refused = m; else rounds++;
  }
  assert.equal(refused && refused.code, 'rejoin_failed', `still seated after ${rounds} rounds`);
  assert.ok(rounds >= 2 && rounds <= 8, `forgiving at first, then over: ${rounds} rounds`);
  assert.ok(!a.msgs.some(m => m.t === 'peer' && m.state === 'lost' && m.grace > 2), 'never more than graceMs');
  assert.deepEqual(await a.next('end'), { t: 'end', winner: 0, reason: 'forfeit', forfeit: true });
  assert.equal((await a.next('room')).phase, 'lobby');
  assert.deepEqual(s.logs, []);
});

test('practice against the AI: nobody is waiting, so every drop gets the full graceMs and nothing is spent', async t => {
  // graceMs 400, away 150 ms each time: as an allowance this would be gone after three drops
  const s = await server(t, { graceMs: 400, graceRefill: 0, resumeDelayMs: 5, stepsPerTick: 1 });
  let client = await connect(s.wsUrl);
  client.send({ t: 'practice', name: 'Solo' });
  const room = await client.next('room');
  client.send({ t: 'ready' });
  await client.next('start');
  for (let drop = 1; drop <= 8; drop++) {
    await client.terminate();
    await sleep(150);
    client = await rejoin(s, room.code, room.token);
    const back = await client.next(m => m.t === 'room' || m.t === 'error');
    assert.equal(back.t, 'room', `drop ${drop}: the seat is still there (${back.code})`);
    assert.equal(back.phase, 'battle');
  }
  assert.deepEqual(s.logs, []);
});

test('a battle result that went into a dead link is sent after the room on the rejoin, and only once', async t => {
  const s = await server(t, { battleTimeLimit: 3, graceMs: 5000 });
  const { a, b, code, roomA, roomB } = await pair(s);
  await readyBoth(a, b, 'start');
  b.ws.pause();                                   // B's link stops delivering; the server does not know yet
  const endA = await a.next('end');
  assert.deepEqual(endA, { t: 'end', winner: -1, reason: 'timeout' });
  await b.terminate();
  await a.next(m => m.t === 'peer' && m.state === 'lost');
  const b2 = await rejoin(s, code, roomB.token);
  const first = await b2.next(), second = await b2.next();
  assert.deepEqual([first.t, first.phase, second], ['room', 'over', endA], 'room, then the missed result');
  // the debt is cleared once sent
  await b2.terminate();
  const b3 = await rejoin(s, code, roomB.token);
  assert.equal((await b3.next('room')).phase, 'over');
  await b3.flush();
  assert.deepEqual(b3.pending().filter(m => m.t !== 'pong'), []);
  // a player who has readied up for the rematch has seen the result: nothing is owed
  b3.send({ t: 'ready' });
  await b3.next(m => m.t === 'room' && m.players[1].ready);
  await b3.terminate();
  const b4 = await rejoin(s, code, roomB.token);
  await b4.next('room');
  await b4.flush();
  assert.deepEqual(b4.pending().filter(m => m.t !== 'pong'), []);
  // Ann saw the result live, and has readied up for the rematch too: nothing is owed to her either
  a.send({ t: 'ready' });
  await a.next(m => m.t === 'room' && m.players[0].ready);
  await a.terminate();
  const a2 = await rejoin(s, code, roomA.token);
  await a2.next('room');
  await a2.flush();
  assert.deepEqual(a2.pending().filter(m => m.t !== 'pong'), []);
  assert.deepEqual(s.logs, []);
});

test('a decisive result is owed with the winner as numbered in that game', async t => {
  const s = await server(t, { graceMs: 5000 });
  const { a, b, code, roomB } = await pair(s);
  await readyBoth(a, b, 'start');
  b.ws.pause();
  for (let n = 0; ; n++) {                        // Ann attacks, Bob never answers
    const m = await a.next(x => x.t === 'snap' || x.t === 'end', 30000);
    if (m.t === 'end') break;
    if (n % 3 === 0) attackNearest(a, 0, m);
  }
  const endA = a.msgs.find(m => m.t === 'end');
  assert.deepEqual([endA.winner, endA.reason], [0, 'rout']);
  await b.terminate();
  const b2 = await rejoin(s, code, roomB.token);
  await b2.next('room');
  assert.deepEqual(await b2.next('end'), endA, 'owed with the winner as numbered in that game');
});

test('a forfeit win is owed to a seat whose socket is dead but not yet noticed (regression: the debt was only kept for a seat already lost)', async t => {
  const s = await server(t, { graceMs: 3000 });
  const { a, b, code, roomA } = await pair(s);
  await readyBoth(a, b, 'start');
  a.ws._socket.pause();                           // Ann's link silently dies: the server still counts her as connected
  b.send({ t: 'leave' });
  await b.next('left');
  const room = s.game._rooms.get(code);
  assert.equal(room.phase, 'lobby');
  assert.ok(room.seats[0].ws, 'the server has not noticed: the seat still has a socket');
  const a2 = await rejoin(s, code, roomA.token);   // she reloads on a new socket
  const first = await a2.next(), second = await a2.next();
  assert.deepEqual([first.t, first.phase, first.you], ['room', 'lobby', 0]);
  assert.deepEqual(second, { t: 'end', winner: 0, reason: 'forfeit', forfeit: true }, 'the win she never saw');
  // owed once: a further rejoin does not repeat it
  await a2.terminate();
  const a3 = await rejoin(s, code, roomA.token);
  await a3.next('room');
  await a3.flush();
  assert.deepEqual(a3.pending().filter(m => m.t !== 'pong'), [], 'the debt was cleared when it was sent');
  a.ws.terminate();
});

test('a forfeit winner who is connected gets the end live, and it is cleared when she readies up', async t => {
  const s = await server(t, { graceMs: 3000 });
  const { a, b, code, roomA } = await pair(s);
  await readyBoth(a, b, 'start');
  b.send({ t: 'leave' });
  await b.next('left');
  assert.deepEqual(await a.next('end'), { t: 'end', winner: 0, reason: 'forfeit', forfeit: true });
  assert.equal((await a.next('room')).phase, 'lobby');
  a.send({ t: 'ready' });                         // she has seen it: nothing is owed any more
  await a.next(m => m.t === 'room' && m.players[0].ready);
  await a.terminate();
  const a2 = await rejoin(s, code, roomA.token);
  await a2.next('room');
  await a2.flush();
  assert.deepEqual(a2.pending().filter(m => m.t !== 'pong'), []);
});
