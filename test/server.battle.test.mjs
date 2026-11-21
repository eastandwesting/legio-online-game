// Quick battles end to end: start, orders, snapshots, end, rematch, practice bot, time limit.
import assert from 'node:assert/strict';
import { test, startTestServer, connect, pair, readyBoth, alive, attackNearest, marchToBattle } from './harness.mjs';

async function server(t, options) {
  const s = await startTestServer(options);
  t.after(() => s.close());
  return s;
}

const lastSnap = c => c.msgs.filter(m => m.t === 'snap').at(-1);

// Plays until 'end' arrives on a; every few snapshots the listed sides attack their nearest enemy.
async function fight(a, b, attackers = [0, 1]) {
  for (let n = 0; ; n++) {
    const m = await a.next(x => x.t === 'snap' || x.t === 'end', 30000);
    if (m.t === 'end') return m;
    if (n % 3) continue;
    if (attackers.includes(0)) attackNearest(a, 0, m);
    if (attackers.includes(1)) attackNearest(b, 1, m);
  }
}

test('quick battle: start, snapshots, the same end for both, then a rematch', async t => {
  const s = await server(t);
  const { a, b } = await pair(s);
  const [startA, startB] = await readyBoth(a, b, 'start');
  assert.equal(startA.you, 0);
  assert.equal(startB.you, 1);
  assert.equal(startA.limit, 300);
  assert.deepEqual([startA.W, startA.H], [1600, 900]);
  assert.ok(startA.types.sword && startA.types.archer.meleeRange === 16);
  // the room message that precedes 'start' says the battle is on
  assert.equal(a.msgs.filter(m => m.t === 'room').at(-1).phase, 'battle');

  const first = await a.next('snap');
  assert.equal(first.regs.length, 18);
  assert.equal(first.regs[0].length, 11);
  assert.ok(first.left <= 300 && first.left > 290);
  const army = side => first.regs.filter(r => r[1] === side).map(r => r[2]).sort().join();
  assert.equal(army(0), army(1), 'both sides field the same army');

  const endA = await fight(a, b, [0]);
  const endB = await b.next('end');
  assert.deepEqual(endA, endB);
  assert.ok([0, 1, -1].includes(endA.winner));
  assert.equal(endA.reason, 'rout');
  assert.ok(!('forfeit' in endA));
  const final = lastSnap(a);
  assert.deepEqual(final, lastSnap(b), 'both saw the same final field');
  for (const side of [0, 1]) {
    const standing = final.regs.some(r => r[1] === side && alive(r));
    assert.equal(standing, endA.winner === side, `side ${side} standing`);
  }
  for (const r of final.regs) assert.ok(r.slice(3, 8).every(Number.isFinite) && r[6] >= 0, 'sane numbers');

  // over: nobody is ready; one ready does nothing, two start a fresh battle
  const over = await a.next('room');
  assert.equal(over.phase, 'over');
  assert.deepEqual(over.players.map(p => p.ready), [false, false]);
  await b.next('room');
  a.send({ t: 'ready' });
  assert.equal((await b.next('room')).phase, 'over');
  b.send({ t: 'ready' });
  await Promise.all([a.next('start'), b.next('start')]);
  const again = await a.next('snap');
  assert.ok(again.time < 5, 'the rematch starts a new clock');
  assert.ok(again.regs.every(alive));
});

test('practice battle: the bot fights and beats a passive player; the bot is ready for the rematch', async t => {
  const s = await server(t, { stepsPerTick: 20 });
  const a = await connect(s.wsUrl);
  a.send({ t: 'practice', name: 'Solo' });
  await a.next('room');
  a.send({ t: 'ready' });
  assert.equal((await a.next('start')).you, 0);
  const end = await a.next('end', 30000);
  assert.deepEqual(end, { t: 'end', winner: 1, reason: 'rout' });
  const over = await a.next('room');
  assert.equal(over.phase, 'over');
  assert.deepEqual(over.players.map(p => p.ready), [false, true]);
  a.send({ t: 'ready' });
  await a.next('start');
  assert.ok((await a.next('snap')).time < 5);
});

test('battle time limit: passive players get end/timeout and a draw', async t => {
  const s = await server(t, { battleTimeLimit: 2, stepsPerTick: 1 });
  const { a, b } = await pair(s);
  const [start] = await readyBoth(a, b, 'start');
  assert.equal(start.limit, 2);
  const endA = await a.next('end'), endB = await b.next('end');
  assert.deepEqual(endA, { t: 'end', winner: -1, reason: 'timeout' });
  assert.deepEqual(endB, endA);
  const snaps = a.msgs.filter(m => m.t === 'snap');
  assert.equal(snaps.length, 40, 'one snapshot per sim tick');
  assert.equal(snaps[0].left, 2);
  assert.equal(snaps.at(-1).left, 0);
  for (let i = 1; i < snaps.length; i++) assert.ok(snaps[i].left <= snaps[i - 1].left && snaps[i].time >= snaps[i - 1].time);
  assert.equal((await a.next('room')).phase, 'over');
});

// The first snapshot taken after the server has processed everything `sender` sent so far.
// (Snapshot times are rounded to 0.1 s, so "later" means at least 0.2 s on.)
async function settled(sender, viewer = sender) {
  await sender.flush();
  if (viewer !== sender) await viewer.flush();
  const mark = lastSnap(viewer);
  return viewer.next(m => m.t === 'snap' && m.time >= mark.time + 0.2);
}

test('orders: move, moves, attack and stop act on the own side only and only during a battle', async t => {
  const s = await server(t, { stepsPerTick: 1 });
  const { a, b } = await pair(s);
  // out of phase: battle orders in the lobby are ignored
  a.send({ t: 'move', ids: [1, 2, 3], x: 800, y: 450 });
  await readyBoth(a, b, 'start');
  const first = await a.next('snap');
  const mine = first.regs.filter(r => r[1] === 0), theirs = first.regs.filter(r => r[1] === 1);
  assert.ok(mine.every(r => [120, 210, 300].includes(r[3])), 'nobody moved before the battle');
  const pos = (snap, id) => { const r = snap.regs.find(x => x[0] === id); return [r[3], r[4]]; };
  const waitUntil = time => a.next(m => m.t === 'snap' && m.time >= time);

  // A orders everything on the field, including B's regiments, to one point
  a.send({ t: 'move', ids: first.regs.map(r => r[0]), x: 500, y: 450, face: 1 });
  let snap = await waitUntil((await settled(a)).time + 0.5);
  for (const r of mine) assert.notDeepEqual(pos(snap, r[0]), [r[3], r[4]], `own regiment ${r[0]} marches`);
  for (const r of theirs) assert.deepEqual(pos(snap, r[0]), [r[3], r[4]], `enemy regiment ${r[0]} stays`);

  // stop: own regiments halt
  a.send({ t: 'stop', ids: mine.map(r => r[0]) });
  const halted = await settled(a);
  snap = await waitUntil(halted.time + 1);
  for (const r of mine) assert.deepEqual(pos(snap, r[0]), pos(halted, r[0]), `regiment ${r[0]} stopped`);

  // moves: one destination per regiment in a single frame (B's side this time)
  const two = theirs.slice(0, 2);
  b.send({ t: 'moves', list: [[two[0][0], 1200, 100, 0.5], [two[1][0], 1200, 800], [mine[0][0], 1200, 450]] });
  const before = await settled(b, a);
  snap = await waitUntil(before.time + 1);
  assert.ok(pos(snap, two[0][0])[1] < two[0][4] - 10, 'first regiment heads up the field');
  assert.ok(pos(snap, two[1][0])[1] > two[1][4] + 10, 'second regiment heads down the field');
  assert.deepEqual(pos(snap, mine[0][0]), pos(halted, mine[0][0]), 'the regiment of the other side ignores it');

  // attack: A's cavalry goes for an enemy; attacking a friend is ignored
  const cav = mine.find(r => r[2] === 'cav'), sword = mine.find(r => r[2] === 'sword');
  a.send({ t: 'attack', ids: [sword[0]], target: cav[0] });
  a.send({ t: 'attack', ids: [cav[0]], target: theirs[0][0] });
  const then = await settled(a);
  snap = await waitUntil(then.time + 1);
  assert.ok(pos(snap, cav[0])[0] > pos(then, cav[0])[0] + 50, 'cavalry rides at the enemy');
  assert.deepEqual(pos(snap, sword[0]), pos(halted, sword[0]), 'no friendly fire order');
});

test('start carries startMen: every regiment of both sides with its men at the start, again on a rejoin', async t => {
  const s = await server(t, { stepsPerTick: 1, graceMs: 5000, resumeDelayMs: 20 });
  const { a, b, code, roomA } = await pair(s);
  const [startA, startB] = await readyBoth(a, b, 'start');
  assert.deepEqual(startA.startMen, startB.startMen, 'both sides get both armies');
  const ids = Object.keys(startA.startMen);
  assert.deepEqual(ids.sort((x, y) => x - y), Array.from({ length: 18 }, (_, i) => String(i + 1)));
  const first = await a.next('snap');
  for (const r of first.regs) {
    assert.ok(Number.isInteger(startA.startMen[String(r[0])]) && startA.startMen[String(r[0])] >= 1);
    assert.equal(startA.startMen[String(r[0])], r[6], `regiment ${r[0]}: men at the start`);
  }
  assert.deepEqual(Object.values(startA.startMen).slice(0, 9), [60, 60, 60, 60, 60, 40, 40, 24, 24]);

  // fight until somebody is clearly hurt, then reload: the denominators must not move
  let hurt = null;
  for (let n = 0; !hurt; n++) {
    const m = await a.next(x => x.t === 'snap', 30000);
    if (n % 3 === 0) { attackNearest(a, 0, m); attackNearest(b, 1, m); }
    hurt = m.regs.find(r => r[6] < startA.startMen[String(r[0])] - 5 && r[8] !== 'dead');
  }
  await a.terminate();
  const a2 = await connect(s.wsUrl);
  a2.send({ t: 'rejoin', code, token: roomA.token });
  await a2.next('room');
  const again = await a2.next('start');
  assert.deepEqual(again.startMen, startA.startMen, 'the same numbers after the rejoin');
  const snap = await a2.next('snap');
  assert.ok(snap.regs.some(r => r[6] < again.startMen[String(r[0])]), 'while the regiments are hurt');
});

test('start carries startMen of a campaign battle: units that came in below full strength', async t => {
  const s = await server(t, { battleTimeLimit: 0.5, resolveDelayMs: 300 });
  const { a, b, code } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  await marchToBattle(a, b, 6);              // resolves with the 300 ms delay before the battle begins
  const room = s.game._rooms.get(code);
  room.camp.armies.find(x => x.id === 1).units[0].men = 33;     // Red's first sword comes in wounded
  room.camp.armies.find(x => x.id === 2).units[3].men = 17;     // Blue's archers too
  const [startA, startB] = await Promise.all([a.next('start'), b.next('start')]);
  assert.deepEqual(startA.startMen, startB.startMen);
  assert.deepEqual(startA.startMen, { 1: 33, 2: 60, 3: 60, 4: 40, 5: 60, 6: 60, 7: 60, 8: 17 });
});
