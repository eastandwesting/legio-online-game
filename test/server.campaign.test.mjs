// Campaign flow end to end: orders, resolution, battles, survivors, hurry-up, rejoin, and the two
// v1 zombie-timer defects (a player leaving during the resolve delay or the gap after a battle).
import assert from 'node:assert/strict';
import { test, startTestServer, connect, pair, readyBoth, sleep, attackNearest, campTurn, marchToBattle } from './harness.mjs';

async function server(t, options) {
  const logs = [];
  const s = await startTestServer({ log: line => logs.push(String(line)), ...options });
  t.after(() => s.close());
  return Object.assign(s, { logs });
}

const lastSnap = c => c.msgs.filter(m => m.t === 'snap').at(-1);
const quiet = c => c.pending().filter(m => m.t !== 'pong');
const camp = (phase, turn) => m => m.t === 'camp' && m.phase === phase && (turn === undefined || m.turn === turn);

async function assertHealthy(s) {
  assert.equal(await (await fetch(`${s.httpUrl}/healthz`)).text(), 'ok');
  const c = await connect(s.wsUrl);
  c.send({ t: 'ping', n: 1 });
  assert.equal((await c.next('pong')).n, 1);
  await c.close();
}

test('campaign against the AI: view contents, battles inside the turn flow, completion, a second campaign', async t => {
  const s = await server(t, { stepsPerTick: 40, betweenMs: 5, resolveDelayMs: 1 });
  const a = await connect(s.wsUrl);
  a.send({ t: 'practice', name: 'Solo', mode: 'campaign' });
  await a.next('room');
  a.send({ t: 'ready' });
  assert.equal((await a.next('room')).phase, 'campaign');

  const first = await a.next('camp');
  assert.deepEqual(Object.keys(first).sort(), ['armies', 'capital', 'cost', 'deadline', 'edges', 'gold', 'income', 'log', 'maxUnits',
    'moves', 'opponent', 'owner', 'phase', 'provs', 'ready', 'replenish', 't', 'turn', 'types', 'units', 'winner', 'you'].sort());
  assert.deepEqual([first.you, first.turn, first.phase, first.winner, first.deadline], [0, 1, 'orders', null, null]);
  assert.deepEqual([first.income, first.units, first.maxUnits, first.replenish], [40, 4, 16, 0.25]);
  assert.equal(first.gold, 400);
  assert.equal(first.cost.cav, 200);
  assert.equal(first.types.archer.men, 40);
  assert.deepEqual([first.provs.length, first.owner.length, first.edges.length], [13, 13, 24]);
  assert.deepEqual(first.capital, [0, 12]);
  assert.deepEqual(first.ready, [false, true], 'the AI has given its orders');
  assert.deepEqual(first.moves, {});
  assert.equal(first.opponent, 'Rival Legate (AI)');
  assert.deepEqual(first.armies[0], { id: 1, owner: 0, prov: 0, units: [
    { type: 'sword', men: 60 }, { type: 'sword', men: 60 }, { type: 'spear', men: 60 }, { type: 'archer', men: 40 }] });

  // A passive player: end every turn, give no battle orders. The AI must finish the game.
  let last = first, starts = 0, ends = 0, final = null;
  a.send({ t: 'endturn' });
  while (!final) {
    const m = await a.next(x => x.t === 'camp' || x.t === 'start' || x.t === 'end', 30000);
    if (m.t === 'start') {
      starts++;
      assert.equal(last.phase, 'battle', 'the campaign view announces the battle first');
      assert.match(last.log.at(-1), /^Armies clash at /);
    } else if (m.t === 'end') {
      ends++;
      assert.ok([0, 1, -1].includes(m.winner) && ['rout', 'timeout'].includes(m.reason));
    } else {
      assert.ok(m.turn <= 60, 'the campaign ends in reasonable time');
      assert.ok(m.log.length <= 8);
      assert.ok(m.deadline === null, 'no hurry-up timer against the AI');
      last = m;
      if (m.winner !== null) final = m;
      else if (m.phase === 'orders' && !m.ready[0]) a.send({ t: 'endturn' });
    }
  }
  assert.equal(final.phase, 'over');
  assert.ok([0, 1, -1].includes(final.winner));
  if (final.winner >= 0) assert.equal(final.owner[final.capital[1 - final.winner]], final.winner, 'the winner holds the enemy capital');
  assert.ok(starts >= 1 && starts === ends, `battles started ${starts}, ended ${ends}`);
  const over = await a.next('room');
  assert.equal(over.phase, 'over');
  assert.deepEqual(over.players.map(p => p.ready), [false, true]);
  // orders after the end are ignored
  a.send({ t: 'endturn' }); a.send({ t: 'recruit', prov: 0, type: 'sword' });
  await a.flush();
  assert.deepEqual(quiet(a), []);

  a.send({ t: 'ready' });
  const fresh = await a.next('camp');
  assert.deepEqual([fresh.turn, fresh.phase, fresh.winner, fresh.gold, fresh.units], [1, 'orders', null, 400, 4]);
  assert.deepEqual(s.logs, []);
});

test('two humans: the attacker meets a defender; on time-out the defender holds and keeps its army', async t => {
  const s = await server(t, { battleTimeLimit: 0.5 });
  const { a, b } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  const [resolving] = await marchToBattle(a, b, 7);
  assert.deepEqual(resolving.armies.map(x => x.prov), [7, 7]);
  assert.deepEqual(resolving.ready, [true, true]);

  const [viewA, viewB] = await Promise.all([a.next(camp('battle')), b.next(camp('battle'))]);
  assert.equal(viewA.log.at(-1), 'Armies clash at Ironridge!');
  assert.deepEqual([viewA.you, viewB.you], [0, 1]);
  const [startA, startB] = await Promise.all([a.next('start'), b.next('start')]);
  assert.deepEqual([startA.you, startB.you, startA.limit], [0, 1, 0.5]);
  const snap = await a.next('snap');
  assert.deepEqual(snap.regs.map(r => r[2]), ['sword', 'sword', 'spear', 'archer', 'sword', 'sword', 'spear', 'archer']);
  const [endA, endB] = await Promise.all([a.next('end'), b.next('end')]);
  assert.deepEqual(endA, { t: 'end', winner: 1, reason: 'timeout' });
  assert.deepEqual(endB, endA);

  // after the gap the campaign goes on by itself: Red's army is gone, Blue's is intact
  const [nextA, nextB] = await Promise.all([a.next(camp('orders')), b.next(camp('orders'))]);
  assert.equal(nextA.turn, 5);
  assert.deepEqual(nextA.armies, [{ id: 2, owner: 1, prov: 7, units: [
    { type: 'sword', men: 60 }, { type: 'sword', men: 60 }, { type: 'spear', men: 60 }, { type: 'archer', men: 40 }] }]);
  assert.deepEqual(nextB.armies, nextA.armies);
  assert.equal(nextA.owner[7], 1);
  assert.ok(nextA.log.includes('Battle at Ironridge: Blue victorious.'));
  assert.deepEqual([nextA.units, nextB.units], [0, 4]);
  // Red is not out: it still earns income and can recruit a new army
  a.send({ t: 'recruit', prov: 0, type: 'sword' });
  assert.equal((await a.next('camp')).units, 1);
  assert.deepEqual(s.logs, []);
});

// What the campaign must hold after a battle, worked out from the last snapshot alone: survivors
// (routed regiments keep half), pooled per type into full units plus one remainder, then one
// turn of replenishment because the winner now stands on its own soil.
function expectedArmy(snap, side, view) {
  const pool = {};
  for (const r of snap.regs) {
    if (r[1] !== side || r[8] === 'dead') continue;
    pool[r[2]] = (pool[r[2]] || 0) + Math.max(1, Math.ceil(r[8] === 'rout' ? r[6] / 2 : r[6]));
  }
  const units = [];
  for (const type of ['sword', 'spear', 'archer', 'cav']) {
    const full = view.types[type].men;
    let men = pool[type] || 0;
    for (; men >= full; men -= full) units.push({ type, men: full });
    if (men > 0) units.push({ type, men });
  }
  return units.map(u => ({ type: u.type, men: Math.min(view.types[u.type].men, u.men + Math.ceil(view.replenish * view.types[u.type].men)) }));
}

test('two humans: a fought battle; the survivors are regrouped into the winner\'s campaign army', async t => {
  const s = await server(t, { stepsPerTick: 20, battleTimeLimit: 150 });
  const { a, b } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  await marchToBattle(a, b, 6);
  await Promise.all([a.next('start'), b.next('start')]);
  let end;
  for (let n = 0; !end; n++) {
    const m = await a.next(x => x.t === 'snap' || x.t === 'end', 30000);
    if (m.t === 'end') end = m;
    else if (n % 2 === 0) attackNearest(a, 0, m);   // Red attacks, Blue only defends itself
  }
  assert.deepEqual(await b.next('end'), end);
  const final = lastSnap(a);
  assert.ok(final.regs.some(r => r[6] < 60 && r[2] !== 'archer'), 'there was a real fight');

  const [view] = await Promise.all([a.next(camp('orders')), b.next(camp('orders'))]);
  const here = view.armies.filter(x => x.prov === 6);
  if (end.winner === -1) {
    assert.deepEqual(view.armies, [], 'a draw removes both armies');
  } else {
    assert.equal(view.armies.length, 1, 'the loser\'s army is removed');
    assert.equal(here[0].owner, end.winner);
    assert.deepEqual(here[0].units, expectedArmy(final, end.winner, view));
    assert.equal(view.owner[6], end.winner, 'the winner takes the province');
    assert.ok(view.log.some(line => /^Battle at Heartland: (Red|Blue) victorious\.$/.test(line)));
  }
  assert.deepEqual(s.logs, []);
});

test('hurry-up timer: the slower human gets hurryMs, then the turn ends with the orders given so far', async t => {
  const s = await server(t, { hurryMs: 400 });
  const { a, b } = await pair(s, 'campaign');
  const [openA, openB] = await readyBoth(a, b, 'camp');
  assert.deepEqual([openA.deadline, openB.deadline], [null, null]);
  b.send({ t: 'cmove', army: 2, to: 10 });
  await b.next(m => m.t === 'camp' && m.moves[2] === 10);

  a.send({ t: 'endturn' });
  const [waitA, waitB] = await Promise.all([a.next(m => m.t === 'camp' && m.ready[0]), b.next(m => m.t === 'camp' && m.ready[0])]);
  assert.deepEqual(waitA.deadline, { who: 1, left: 1 });
  assert.deepEqual(waitB.deadline, { who: 1, left: 1 });
  // Blue may keep giving orders until the deadline; Red's turn is closed
  b.send({ t: 'recruit', prov: 12, type: 'sword' });
  a.send({ t: 'recruit', prov: 0, type: 'sword' });
  const recruited = await b.next('camp');
  assert.deepEqual([recruited.units, recruited.deadline.who], [5, 1]);

  // nobody sends endturn for Blue: the timer does
  const [nextA, nextB] = await Promise.all([a.next(camp('orders', 2)), b.next(camp('orders', 2))]);
  assert.ok(nextA.log.includes('Blue ran out of time.'));
  const blue = nextB.armies.find(x => x.owner === 1);
  assert.deepEqual([blue.prov, blue.units.length], [10, 5], 'the march and the recruit ordered before the deadline happened');
  assert.deepEqual([nextA.units, nextB.units], [4, 5]);
  assert.deepEqual([nextA.deadline, nextB.deadline, nextA.ready], [null, null, [false, false]]);
  // no timer is left over: the next turn waits for the players
  await sleep(600);
  await a.flush();
  assert.deepEqual(quiet(a), []);
  assert.deepEqual(s.logs, []);
});

test('hurry-up timer does not run while the room is paused', async t => {
  const s = await server(t, { hurryMs: 600, graceMs: 5000, resumeDelayMs: 100 });
  const { a, b, code, roomB } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  a.send({ t: 'endturn' });
  await b.next(m => m.t === 'camp' && m.deadline !== null);
  await a.next(m => m.t === 'camp' && m.deadline !== null);
  await b.terminate();
  // the player who stayed is told at once that no countdown is running
  const frozen = await a.next('camp');
  assert.deepEqual([frozen.phase, frozen.deadline], ['orders', null]);
  assert.equal((await a.next('peer')).state, 'lost');
  await sleep(900);   // well past the hurry time
  await a.flush();
  assert.ok(!a.msgs.some(m => m.t === 'camp' && m.phase !== 'orders'), 'the turn was not ended for the absent player');

  const b2 = await connect(s.wsUrl);
  b2.send({ t: 'rejoin', code, token: roomB.token });
  assert.equal((await b2.next('room')).phase, 'campaign');
  const back = await b2.next('camp');
  assert.deepEqual([back.you, back.phase, back.turn, back.ready], [1, 'orders', 1, [true, false]]);
  assert.equal(back.deadline, null, 'still paused for the resume delay: no countdown yet');
  // when the room resumes the countdown is back where it stopped, for both, and then runs out
  const [resumedA, resumedB] = await Promise.all([a.next(m => m.t === 'camp' && m.deadline !== null), b2.next(m => m.t === 'camp' && m.deadline !== null)]);
  assert.deepEqual([resumedA.deadline, resumedB.deadline], [{ who: 1, left: 1 }, { who: 1, left: 1 }]);
  await Promise.all([a.next(camp('orders', 2)), b2.next(camp('orders', 2))]);
  assert.deepEqual(s.logs, []);
});

test('rejoin during campaign orders keeps gold, recruits and marches; each view is private', async t => {
  const s = await server(t, { graceMs: 5000 });
  const { a, b, code, roomA } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  a.send({ t: 'recruit', prov: 0, type: 'cav' });
  a.send({ t: 'cmove', army: 1, to: 2 });
  const mine = await a.next(m => m.t === 'camp' && m.moves[1] === 2);
  assert.deepEqual([mine.gold, mine.units, mine.moves], [200, 5, { 1: 2 }]);
  const theirs = await b.next(m => m.t === 'camp' && m.armies[0].units.length === 5);
  await b.flush();
  for (const m of b.msgs.filter(x => x.t === 'camp')) {
    assert.equal(m.gold, 400, 'Blue never sees Red\'s gold');
    assert.deepEqual(m.moves, {}, 'Blue never sees Red\'s marches');
  }
  assert.equal(theirs.units, 4);

  await a.terminate();
  assert.equal((await b.next('peer')).state, 'lost');
  b.send({ t: 'cmove', army: 2, to: 10 });   // turn-based orders are still taken while the opponent is away
  assert.deepEqual((await b.next(m => m.t === 'camp' && m.moves[2] === 10)).moves, { 2: 10 });

  const a2 = await connect(s.wsUrl);
  a2.send({ t: 'rejoin', code, token: roomA.token });
  const room = await a2.next();
  assert.deepEqual([room.t, room.phase, room.you], ['room', 'campaign', 0]);
  const view = await a2.next();
  assert.equal(view.t, 'camp');
  assert.deepEqual([view.you, view.turn, view.phase, view.gold, view.units, view.moves], [0, 1, 'orders', 200, 5, { 1: 2 }]);
  assert.deepEqual(view.ready, [false, false]);
  await a2.flush();
  assert.deepEqual(quiet(a2), [], 'no battle is running, so no start');

  // the kept orders are carried out
  a2.send({ t: 'endturn' }); b.send({ t: 'endturn' });
  const next = await a2.next(camp('orders', 2));
  assert.deepEqual(next.armies.map(x => [x.owner, x.prov, x.units.length]), [[0, 2, 5], [1, 10, 4]]);
  assert.deepEqual(s.logs, []);
});

test('regression: a player leaving during the resolve delay leaves no timer behind', async t => {
  const s = await server(t, { resolveDelayMs: 300 });
  const { a, b, code } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  a.send({ t: 'endturn' }); b.send({ t: 'endturn' });
  await Promise.all([a.next(camp('resolving')), b.next(camp('resolving'))]);
  a.send({ t: 'leave' });
  await a.next('left');
  assert.deepEqual(await b.next('end'), { t: 'end', winner: 1, reason: 'forfeit', forfeit: true });
  assert.equal((await b.next('room')).phase, 'lobby');

  // Start a new campaign in the same room while the old timer would still be pending.
  // v1: the old callback ran against the cleared campaign (C.settle(null)) and killed the process.
  a.send({ t: 'join', code, name: 'Ann' });
  await a.next('room');
  const [freshA] = await readyBoth(b, a, 'camp');
  assert.deepEqual([freshA.turn, freshA.phase], [1, 'orders']);
  await sleep(600);
  await a.flush(); await b.flush();
  assert.deepEqual(quiet(a), [], 'the old turn did not resolve into the new campaign');
  assert.deepEqual(quiet(b), []);
  assert.deepEqual(s.logs, [], 'nothing threw');
  await assertHealthy(s);
});

test('regression: a player leaving during the gap after a campaign battle starts no ghost battle', async t => {
  const s = await server(t, { battleTimeLimit: 0.5, betweenMs: 300 });
  const { a, b, code } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  await marchToBattle(a, b, 6);
  await Promise.all([a.next('end'), b.next('end')]);
  // now in phase 'between': the result is applied in 300 ms
  b.send({ t: 'leave' });
  await b.next('left');
  assert.deepEqual(await a.next('end'), { t: 'end', winner: 0, reason: 'forfeit', forfeit: true });
  const lobby = await a.next('room');
  assert.deepEqual([lobby.phase, lobby.players.length], ['lobby', 1]);

  // v1: the gap timer then called back into the room that was back in the lobby
  await sleep(600);
  await a.flush();
  assert.deepEqual(quiet(a), [], 'no camp, no start, no end after the room went back to the lobby');
  assert.equal(s.game._rooms.get(code).phase, 'lobby');
  assert.deepEqual(s.logs, []);
  await assertHealthy(s);
  // the room is an ordinary lobby again
  b.send({ t: 'join', code, name: 'Bob' });
  await b.next('room');
  const [fresh] = await readyBoth(a, b, 'camp');
  assert.deepEqual([fresh.turn, fresh.phase, fresh.armies.length], [1, 'orders', 2]);
});

test('regression: a practice campaign abandoned during resolution or after a battle is destroyed cleanly', async t => {
  const s = await server(t, { resolveDelayMs: 200, graceMs: 30 });
  const s2 = await server(t, { resolveDelayMs: 1, betweenMs: 200, graceMs: 30, stepsPerTick: 40 });
  // 1. dropped during the resolve delay
  const a = await connect(s.wsUrl);
  a.send({ t: 'practice', name: 'Solo', mode: 'campaign' });
  await a.next('room');
  a.send({ t: 'ready' });
  await a.next('camp');
  a.send({ t: 'endturn' });
  await a.next(camp('resolving'));
  await a.terminate();
  // 2. dropped in the gap after a battle against the AI
  const c = await connect(s2.wsUrl);
  c.send({ t: 'practice', name: 'Solo', mode: 'campaign' });
  await c.next('room');
  c.send({ t: 'ready' });
  for (;;) {
    const m = await c.next(x => x.t === 'end' || (x.t === 'camp' && x.phase === 'orders' && !x.ready[0]), 30000);
    if (m.t === 'end') break;
    c.send({ t: 'endturn' });
  }
  await c.terminate();
  for (let i = 0; i < 100 && (s.game.stats().rooms || s2.game.stats().rooms); i++) await sleep(10);
  assert.deepEqual([s.game.stats().rooms, s2.game.stats().rooms], [0, 0]);
  await sleep(400);   // past both delays
  assert.deepEqual([s.logs, s2.logs], [[], []]);
  await assertHealthy(s);
  await assertHealthy(s2);
});

test('a campaign battle that becomes due while a player is away starts paused and waits', async t => {
  const s = await server(t, { resolveDelayMs: 300, graceMs: 5000, stepsPerTick: 1, battleTimeLimit: 1 });
  const { a, b, code, roomB } = await pair(s, 'campaign');
  await readyBoth(a, b, 'camp');
  await marchToBattle(a, b, 6);
  await b.terminate();   // during the resolve delay
  assert.equal((await a.next('peer')).state, 'lost');
  assert.equal((await a.next('start')).you, 0);
  await sleep(150);
  await a.flush();
  // one snapshot of the field to look at, and then nothing: the battle does not run without the absent player
  assert.deepEqual(a.pending().filter(m => m.t === 'snap' || m.t === 'end').map(m => [m.t, m.time]), [['snap', 0]]);

  const b2 = await connect(s.wsUrl);
  b2.send({ t: 'rejoin', code, token: roomB.token });
  const sync = [await b2.next(), await b2.next(), await b2.next(), await b2.next()];
  assert.deepEqual(sync.map(m => m.t), ['room', 'camp', 'start', 'snap']);
  assert.deepEqual([sync[0].phase, sync[1].phase, sync[2].you, sync[3].time], ['battle', 'battle', 1, 0]);
  const [endA, endB] = await Promise.all([a.next('end'), b2.next('end')]);
  assert.deepEqual(endA, endB);
  assert.equal(endA.reason, 'timeout');
  await Promise.all([a.next(camp('orders')), b2.next(camp('orders'))]);
  assert.deepEqual(s.logs, []);
});
