// Campaign rules (SPEC section 5): pure logic, no server, no ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPES } from '../sim.js';
import * as C from '../campaign.js';

// ---------- helpers ----------
const men = units => units.reduce((s, u) => s + u.men, 0);
const unit = (type, m = TYPES[type].men) => ({ type, men: m });
const units = (type, n) => Array.from({ length: n }, () => unit(type));
const armyOf = (c, id) => c.armies.find(a => a.id === id);

// Seeded PRNG (mulberry32): the tests must be reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

// A campaign with hand-placed armies: list of [owner, prov, units]. Gold defaults to 0 so that the AI
// cannot recruit and change the sizes a test set up.
function setup(armies, { gold = [0, 0], owner } = {}) {
  const c = C.newCampaign();
  c.armies = armies.map(([o, prov, us], i) => ({ id: i + 1, owner: o, prov, units: us }));
  c.nextId = armies.length + 1;
  c.gold = [...gold];
  if (owner) for (const [prov, o] of Object.entries(owner)) c.owner[+prov] = o;
  return c;
}

// The call must be refused: returns false and leaves the campaign exactly as it was.
function refused(c, fn, label) {
  const before = structuredClone(c);
  let out;
  assert.doesNotThrow(() => { out = fn(); }, label);
  assert.equal(out, false, label);
  assert.deepEqual(c, before, label);
}

function checkState(c, label = '') {
  const at = `${label} turn ${c.turn}`;
  assert.equal(c.owner.length, C.PROVS.length, at);
  for (const o of c.owner) assert.ok(o === -1 || o === 0 || o === 1, `${at}: owner ${o}`);
  assert.ok([null, 0, 1, -1].includes(c.winner), `${at}: winner ${c.winner}`);
  assert.ok(Number.isInteger(c.turn) && c.turn >= 1, at);
  const ids = new Set();
  for (const p of [0, 1]) {
    assert.ok(Number.isInteger(c.gold[p]) && c.gold[p] >= 0, `${at}: gold[${p}] = ${c.gold[p]}`);
    assert.ok(C.totalUnits(c, p) <= C.MAX_UNITS, `${at}: player ${p} has ${C.totalUnits(c, p)} units`);
    if (c.winner === null) assert.equal(c.owner[C.CAPITAL[p]], p, `${at}: capital ${p} lost without a result`);
  }
  for (const a of c.armies) {
    assert.ok(Number.isInteger(a.id) && a.id >= 1 && a.id < c.nextId && !ids.has(a.id), `${at}: army id ${a.id}`);
    ids.add(a.id);
    assert.ok(a.owner === 0 || a.owner === 1, `${at}: army owner`);
    assert.ok(Number.isInteger(a.prov) && a.prov >= 0 && a.prov < C.PROVS.length, `${at}: army prov ${a.prov}`);
    assert.ok(a.units.length >= 1, `${at}: empty army ${a.id}`);
    for (const u of a.units) {
      assert.ok(Object.hasOwn(TYPES, u.type), `${at}: unit type ${String(u.type)}`);
      assert.ok(Number.isInteger(u.men) && u.men >= 1 && u.men <= TYPES[u.type].men, `${at}: ${u.type} men ${u.men}`);
    }
  }
}

// After resolveMoves: one army per player per province, no orders left over.
function checkResolved(c, label) {
  const spots = new Set();
  for (const a of c.armies) {
    const key = `${a.owner}@${a.prov}`;
    assert.ok(!spots.has(key), `${label} turn ${c.turn}: two armies of player ${a.owner} in province ${a.prov}`);
    spots.add(key);
  }
  assert.deepEqual(c.moves, [{}, {}], label);
}

// Battle auto-resolution by a simple strength comparison (men, with optional seeded noise).
// Equal strength: the defender holds, or a draw on neutral ground.
function fight(u0, u1, defender, rnd = null, noise = 0) {
  const wobble = () => (rnd ? 1 + noise * (rnd() - 0.5) : 1);
  const s = [men(u0) * wobble(), men(u1) * wobble()];
  const winner = s[0] > s[1] ? 0 : s[1] > s[0] ? 1 : defender ?? -1;
  const survivors = [[], []];
  if (winner >= 0) {
    const keep = Math.max(0, 1 - 0.8 * s[1 - winner] / s[winner]);
    const left = u => ({ type: u.type, men: Math.floor(u.men * keep) });
    survivors[winner] = [u0, u1][winner].map(left).filter(u => u.men >= 1);
  }
  return { winner, survivors };
}

// Everything the server does between two orders phases. Returns what happened.
function playTurn(c, { rnd = null, noise = 0, label = '' } = {}) {
  const battles = C.resolveMoves(c);
  checkResolved(c, label);
  const owned = c.owner.join();
  for (const b of battles) {
    assert.ok(b.defender === null || b.defender === 0 || b.defender === 1, label);
    const a0 = armyOf(c, b.a0), a1 = armyOf(c, b.a1);
    assert.ok(a0 && a1 && a0.owner === 0 && a1.owner === 1 && a0.prov === b.prov && a1.prov === b.prov, label);
    const { winner, survivors } = fight(a0.units, a1.units, b.defender, rnd, noise);
    assert.equal(C.applyBattle(c, b, winner, survivors), true, label);
  }
  assert.equal(C.settle(c), true, label);
  const captured = c.owner.join() !== owned;
  if (c.winner === null) assert.equal(C.endTurn(c), true, label);
  checkState(c, label);
  return { battles, captured };
}

// ---------- constants and setup ----------
test('exports and map constants', () => {
  for (const name of ['PROVS', 'CAPITAL', 'EDGES', 'ADJ', 'COST', 'START_GOLD', 'INCOME', 'MAX_UNITS', 'REPLENISH',
    'newCampaign', 'totalUnits', 'recruit', 'setMove', 'resolveMoves', 'applyBattle', 'settle', 'endTurn', 'aiTurn',
    'regroup']) assert.ok(name in C, `missing export ${name}`);
  assert.equal(C.REPLENISH, 0.25);
  assert.deepEqual(C.CAPITAL, [0, 12]);
  assert.equal(C.ADJ.length, C.PROVS.length);
  for (const [a, b] of C.EDGES) assert.ok(C.ADJ[a].includes(b) && C.ADJ[b].includes(a));
  for (const type of Object.keys(C.COST)) assert.ok(Object.hasOwn(TYPES, type), `COST type ${type} unknown to sim`);
});

test('newCampaign: shape read by the server, independent instances', () => {
  const c = C.newCampaign();
  assert.equal(c.turn, 1);
  assert.equal(c.winner, null);
  assert.deepEqual(c.gold, [C.START_GOLD, C.START_GOLD]);
  assert.deepEqual(c.moves, [{}, {}]);
  assert.deepEqual(c.ready, [false, false]);
  assert.equal(c.armies.length, 2);
  assert.deepEqual(c.armies.map(a => [a.id, a.owner, a.prov]), [[1, 0, 0], [2, 1, 12]]);
  assert.equal(c.nextId, 3);
  assert.ok(Array.isArray(c.log) && c.log.length === 1);
  assert.equal(c.owner[0], 0);
  assert.equal(c.owner[12], 1);
  checkState(c);
  const d = C.newCampaign();
  d.armies[0].units[0].men = 1; d.owner[6] = 0; d.gold[0] = 0;
  assert.deepEqual(C.newCampaign(), c, 'a second campaign must not share state with the first');
});

// ---------- recruit ----------
test('recruit: adds a full-strength unit and charges gold', () => {
  const c = C.newCampaign();
  assert.equal(C.recruit(c, 0, 0, 'cav'), true);
  assert.equal(c.gold[0], C.START_GOLD - C.COST.cav);
  assert.equal(c.armies.length, 2, 'joins the army already in the province');
  assert.deepEqual(armyOf(c, 1).units.at(-1), { type: 'cav', men: TYPES.cav.men });
  assert.equal(C.recruit(c, 0, 1, 'sword'), true, 'own province without an army');
  const fresh = c.armies.find(a => a.owner === 0 && a.prov === 1);
  assert.equal(fresh.id, 3);
  assert.equal(c.nextId, 4);
  assert.deepEqual(fresh.units, [{ type: 'sword', men: TYPES.sword.men }]);
  assert.equal(C.totalUnits(c, 0), 6);
  assert.equal(C.totalUnits(c, 1), 4);
  checkState(c);
});

test('recruit: rejects prototype keys and other bad types (regression: "constructor" made gold NaN)', () => {
  const c = C.newCampaign();
  const bad = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '', 'Sword', 'sword ',
    null, undefined, 0, 1, NaN, {}, [], ['sword'], { toString: () => 'sword' }, () => 'sword', Symbol('sword'), true];
  for (const type of bad) refused(c, () => C.recruit(c, 0, 0, type), `type ${String(type)}`);
  assert.equal(c.gold[0], C.START_GOLD);
  assert.equal(C.totalUnits(c, 0), 4);
});

test('recruit: rejects bad players, bad provinces, foreign soil, no gold, finished campaigns', () => {
  const c = C.newCampaign();
  for (const p of [2, -1, 1.5, '0', null, undefined, NaN, [0], {}, true]) {
    refused(c, () => C.recruit(c, p, 0, 'sword'), `player ${String(p)}`);
  }
  for (const prov of [-1, 13, 1.5, '0', null, undefined, NaN, Infinity, [0], {}, '__proto__', 'length', true]) {
    refused(c, () => C.recruit(c, 0, prov, 'sword'), `prov ${String(prov)}`);
  }
  refused(c, () => C.recruit(c, 0, 12, 'sword'), 'enemy province');
  refused(c, () => C.recruit(c, 0, 6, 'sword'), 'neutral province');
  refused(c, () => C.recruit(c, 1, 0, 'sword'), 'enemy capital');
  c.gold[0] = C.COST.sword - 1;
  refused(c, () => C.recruit(c, 0, 0, 'sword'), 'one gold short');
  c.gold[0] = NaN;
  refused(c, () => C.recruit(c, 0, 0, 'sword'), 'NaN gold buys nothing');
  c.gold[0] = 1000; c.winner = 1;
  refused(c, () => C.recruit(c, 0, 0, 'sword'), 'campaign over');
});

test('recruit: unit cap', () => {
  const c = C.newCampaign();
  c.gold[0] = 100000;
  let bought = 0;
  while (C.recruit(c, 0, bought % 4, 'sword')) bought++;
  assert.equal(bought, C.MAX_UNITS - 4);
  assert.equal(C.totalUnits(c, 0), C.MAX_UNITS);
  refused(c, () => C.recruit(c, 0, 0, 'sword'), 'at the cap');
  assert.equal(c.gold[0], 100000 - bought * C.COST.sword);
  checkState(c);
});

// ---------- setMove ----------
test('setMove: adjacent marches only, null cancels', () => {
  const c = C.newCampaign();
  assert.equal(C.setMove(c, 0, 1, 2), true);
  assert.deepEqual(c.moves, [{ 1: 2 }, {}]);
  assert.equal(C.setMove(c, 0, 1, 3), true, 'a new order replaces the old one');
  assert.deepEqual(c.moves, [{ 1: 3 }, {}]);
  assert.equal(C.setMove(c, 0, 1, null), true);
  assert.deepEqual(c.moves, [{}, {}]);
  assert.equal(C.setMove(c, 0, 1, null), true, 'cancelling nothing is fine');
  refused(c, () => C.setMove(c, 0, 1, 0), 'own province is not a march');
  refused(c, () => C.setMove(c, 0, 1, 4), 'two steps away');
  refused(c, () => C.setMove(c, 0, 1, 12), 'far away');
});

test('setMove: rejects bad input and other players\' armies', () => {
  const c = C.newCampaign();
  C.setMove(c, 0, 1, 2);
  for (const to of [undefined, '2', 2.5, -1, 13, 99, NaN, Infinity, {}, [2], true, '__proto__']) {
    refused(c, () => C.setMove(c, 0, 1, to), `to ${String(to)}`);
  }
  for (const id of ['1', 1.5, NaN, null, undefined, 0, 99, -1, '__proto__', 'constructor', {}, [1]]) {
    refused(c, () => C.setMove(c, 0, id, 2), `army ${String(id)}`);
    refused(c, () => C.setMove(c, 0, id, null), `cancel army ${String(id)}`);
  }
  refused(c, () => C.setMove(c, 0, 2, 9), 'enemy army');
  refused(c, () => C.setMove(c, 1, 1, 2), 'enemy army (other seat)');
  refused(c, () => C.setMove(c, 1, 1, null), 'cancelling an enemy order');
  for (const p of [2, -1, '0', null, undefined, NaN]) refused(c, () => C.setMove(c, p, 1, 2), `player ${String(p)}`);
  c.winner = -1;
  refused(c, () => C.setMove(c, 0, 1, 3), 'campaign over');
});

// ---------- resolveMoves ----------
test('resolveMoves: armies march, orders are cleared, no battle without contact', () => {
  const c = C.newCampaign();
  C.setMove(c, 0, 1, 2); C.setMove(c, 1, 2, 10);
  assert.deepEqual(C.resolveMoves(c), []);
  assert.equal(armyOf(c, 1).prov, 2);
  assert.equal(armyOf(c, 2).prov, 10);
  assert.deepEqual(c.moves, [{}, {}]);
  assert.deepEqual(c.bounced, []);
});

test('resolveMoves: armies crossing paths turn back (bounce)', () => {
  const c = setup([[0, 4, units('sword', 2)], [1, 7, units('sword', 2)]]);
  assert.equal(C.setMove(c, 0, 1, 7), true);
  assert.equal(C.setMove(c, 1, 2, 4), true);
  const logged = c.log.length;
  assert.deepEqual(C.resolveMoves(c), []);
  assert.equal(armyOf(c, 1).prov, 4);
  assert.equal(armyOf(c, 2).prov, 7);
  assert.deepEqual(c.moves, [{}, {}]);
  assert.deepEqual([...c.bounced].sort(), [1, 2]);
  assert.equal(c.log.length, logged + 1);
  assert.match(c.log.at(-1), /turned back/);
  // the next turn nobody bounces: the flag is reset
  C.setMove(c, 0, 1, 7);
  const battles = C.resolveMoves(c);
  assert.deepEqual(c.bounced, []);
  assert.deepEqual(battles, [{ prov: 7, a0: 1, a1: 2, defender: null }]);
});

test('resolveMoves: a third army still reaches a province whose army bounced', () => {
  const c = setup([[0, 4, units('sword', 2)], [1, 7, units('sword', 2)], [0, 6, units('spear', 1)]]);
  C.setMove(c, 0, 1, 7); C.setMove(c, 1, 2, 4); C.setMove(c, 0, 3, 7);
  const battles = C.resolveMoves(c);
  assert.equal(armyOf(c, 1).prov, 4);
  assert.deepEqual(battles, [{ prov: 7, a0: 3, a1: 2, defender: null }]);
});

test('resolveMoves: own armies may swap places and merge when they meet', () => {
  const c = setup([[0, 1, units('sword', 2)], [0, 2, units('spear', 3)], [0, 3, [unit('cav', 7)]],
    [1, 12, units('sword', 1)]]);
  // swap: no bounce between armies of the same player
  C.setMove(c, 0, 1, 2); C.setMove(c, 0, 2, 1);
  assert.deepEqual(C.resolveMoves(c), []);
  assert.equal(armyOf(c, 1).prov, 2);
  assert.equal(armyOf(c, 2).prov, 1);
  assert.deepEqual(c.bounced, []);
  // merge: armies 2 and 3 walk into army 1's province
  C.setMove(c, 0, 2, 2); C.setMove(c, 0, 3, 2);
  assert.deepEqual(C.resolveMoves(c), []);
  const mine = c.armies.filter(a => a.owner === 0);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, 1, 'the earlier army keeps its id');
  assert.equal(mine[0].prov, 2);
  assert.deepEqual(mine[0].units, [...units('sword', 2), ...units('spear', 3), unit('cav', 7)]);
  assert.equal(C.totalUnits(c, 0), 6);
  assert.equal(c.armies.length, 2);
  checkResolved(c, 'merge');
});

test('resolveMoves: battle list with the defender = owner before this turn\'s captures', () => {
  const c = setup([
    [0, 2, units('sword', 1)], [1, 4, units('sword', 1)],   // blue walks into red Midvale
    [0, 8, units('sword', 1)], [1, 10, units('sword', 1)],  // red walks into blue Dunemouth
    [0, 5, units('sword', 1)], [1, 7, units('sword', 1)],   // both walk into neutral Heartland
    [0, 0, units('sword', 1)], [1, 12, units('sword', 1)],  // garrisons: no battle
  ]);
  C.setMove(c, 1, 2, 2); C.setMove(c, 0, 3, 10); C.setMove(c, 0, 5, 6); C.setMove(c, 1, 6, 6);
  const battles = C.resolveMoves(c);
  assert.deepEqual(battles, [
    { prov: 2, a0: 1, a1: 2, defender: 0 },
    { prov: 6, a0: 5, a1: 6, defender: null },
    { prov: 10, a0: 3, a1: 4, defender: 1 },
  ]);
  assert.equal(c.owner[2], 0, 'resolveMoves does not capture anything itself');
  assert.equal(c.owner[10], 1);
});

test('resolveMoves: ignores orders that are not a real adjacent step, never throws on garbage', () => {
  const c = C.newCampaign();
  c.moves[0] = { 1: 12, 99: 2, constructor: 3 };
  c.moves[1] = { 2: '10' };
  assert.deepEqual(C.resolveMoves(c), []);
  assert.equal(armyOf(c, 1).prov, 0);
  assert.equal(armyOf(c, 2).prov, 12);
  assert.deepEqual(c.moves, [{}, {}]);
  const husk = { armies: [null], owner: [], gold: [], moves: [], log: [] };
  for (const junk of [null, undefined, 0, 'x', [], {}, { armies: [] }, husk]) assert.deepEqual(C.resolveMoves(junk), []);
  c.winner = 0;
  C.setMove(c, 0, 1, 2);
  assert.deepEqual(C.resolveMoves(c), [], 'no marching once the campaign is over');
});

// ---------- regroup ----------
test('regroup: pools men per type into full units plus at most one remainder', () => {
  const out = C.regroup([unit('cav', 5), unit('sword', 50), unit('archer', 40), unit('sword', 45), unit('spear', 1),
    unit('sword', 30), unit('cav', 20)]);
  assert.deepEqual(out, [
    { type: 'sword', men: 60 }, { type: 'sword', men: 60 }, { type: 'sword', men: 5 },
    { type: 'spear', men: 1 }, { type: 'archer', men: 40 }, { type: 'cav', men: 24 }, { type: 'cav', men: 1 },
  ]);
  assert.deepEqual(C.regroup([]), []);
  assert.deepEqual(C.regroup(units('sword', 3)), units('sword', 3));
});

test('regroup: conserves men per type (seeded property test)', () => {
  const rnd = rng(7), types = Object.keys(C.COST);
  for (let i = 0; i < 500; i++) {
    const input = Array.from({ length: Math.floor(rnd() * 20) }, () => {
      const type = pick(rnd, types);
      return unit(type, 1 + Math.floor(rnd() * TYPES[type].men));
    });
    const copy = structuredClone(input);
    const out = C.regroup(input);
    assert.deepEqual(input, copy, 'input not modified');
    assert.ok(out.length <= input.length, 'never more units than before');
    let last = -1;
    for (const type of types) {
      const mine = out.filter(u => u.type === type);
      assert.equal(men(mine), men(input.filter(u => u.type === type)), `${type} men conserved`);
      assert.ok(mine.filter(u => u.men < TYPES[type].men).length <= 1, `${type}: one remainder at most`);
      for (const u of mine) assert.ok(Number.isInteger(u.men) && u.men >= 1 && u.men <= TYPES[type].men);
      if (mine.length) { const first = out.indexOf(mine[0]); assert.ok(first > last, 'type order'); last = first; }
    }
    assert.equal(out.length, types.reduce((s, t) => s + out.filter(u => u.type === t).length, 0), 'no stray types');
  }
});

test('regroup: drops unknown types and garbage, never throws', () => {
  assert.deepEqual(C.regroup([unit('sword', 10), { type: 'constructor', men: 5 }, { type: '__proto__', men: 5 },
    { type: 'elephant', men: 30 }, null, undefined, 7, 'sword', { men: 9 }, { type: 'sword' },
    { type: 'sword', men: NaN },
    { type: 'sword', men: -4 }, { type: 'sword', men: 0 }, { type: 'sword', men: '12' }, { type: 'spear', men: 2.9 },
    { type: 'sword', men: Symbol('9') }, { type: 'sword', men: 9n }, { type: 'sword', men: [9] },
    { type: 'sword', men: {} },
    { type: Symbol('sword'), men: 9 }, { type: ['sword'], men: 9 }]),
  [{ type: 'sword', men: 10 }, { type: 'spear', men: 2 }]);
  // a unit can never hold more than its full strength, so absurd input cannot blow up the army
  assert.deepEqual(C.regroup([{ type: 'cav', men: 1e12 }, { type: 'cav', men: Infinity }]), units('cav', 2));
  for (const junk of [null, undefined, 0, 'x', {}, { length: 3 }, () => []]) assert.deepEqual(C.regroup(junk), []);
});

// ---------- applyBattle ----------
function clash() { // red 3 swords walk into blue Dunemouth held by 2 spears
  const c = setup([[0, 8, units('sword', 3)], [1, 10, units('spear', 2)], [0, 0, units('archer', 1)]]);
  C.setMove(c, 0, 1, 10);
  const battles = C.resolveMoves(c);
  assert.deepEqual(battles, [{ prov: 10, a0: 1, a1: 2, defender: 1 }]);
  return { c, b: battles[0] };
}

test('applyBattle: loser removed, winner keeps regrouped survivors', () => {
  const { c, b } = clash();
  const survivors = [[unit('sword', 20), unit('sword', 50), unit('sword', 1)], [unit('spear', 30)]];
  assert.equal(C.applyBattle(c, b, 0, survivors), true);
  assert.equal(armyOf(c, 2), undefined, 'loser gone even though some of its men lived');
  assert.deepEqual(armyOf(c, 1).units, [{ type: 'sword', men: 60 }, { type: 'sword', men: 11 }]);
  assert.notEqual(armyOf(c, 1).units, survivors[0], 'the caller\'s array is not kept');
  assert.equal(armyOf(c, 1).prov, 10);
  assert.equal(c.armies.length, 2, 'the uninvolved army is untouched');
  assert.match(c.log.at(-1), /Dunemouth.*Red victorious/);
  checkState(c);
});

test('applyBattle: the other side can win too', () => {
  const { c, b } = clash();
  assert.equal(C.applyBattle(c, b, 1, [[unit('sword', 60)], [unit('spear', 31), unit('spear', 31)]]), true);
  assert.equal(armyOf(c, 1), undefined);
  assert.deepEqual(armyOf(c, 2).units, [{ type: 'spear', men: 60 }, { type: 'spear', men: 2 }]);
  assert.match(c.log.at(-1), /Blue victorious/);
});

test('applyBattle: a draw removes both armies', () => {
  const { c, b } = clash();
  assert.equal(C.applyBattle(c, b, -1, [units('sword', 3), units('spear', 2)]), true);
  assert.deepEqual(c.armies.map(a => a.id), [3]);
  assert.match(c.log.at(-1), /both armies destroyed/);
  const again = clash();
  assert.equal(C.applyBattle(again.c, again.b, -1), true, 'a draw needs no survivor lists');
  assert.deepEqual(again.c.armies.map(a => a.id), [3]);
});

test('applyBattle: a winner without survivors loses its army as well', () => {
  const { c, b } = clash();
  assert.equal(C.applyBattle(c, b, 0, [[], units('spear', 2)]), true);
  assert.deepEqual(c.armies.map(a => a.id), [3]);
  const again = clash();
  assert.equal(C.applyBattle(again.c, again.b, 1, [[], [{ type: 'ghost', men: 5 }]]), true);
  assert.deepEqual(again.c.armies.map(a => a.id), [3]);
});

test('applyBattle: bad input is refused without touching the campaign', () => {
  const { c, b } = clash();
  const sv = [units('sword', 1), units('spear', 1)];
  for (const winner of [2, -2, null, undefined, '0', 0.5, NaN, true, {}]) {
    refused(c, () => C.applyBattle(c, b, winner, sv), `winner ${String(winner)}`);
  }
  const battles = [null, undefined, 5, 'x', [], {}, { a0: 1 }, { a0: 2, a1: 1 }, { a0: 1, a1: 3 }, { a0: 99, a1: 2 },
    { a0: '1', a1: '2' }, { a0: 1, a1: 1 }, { a0: 3, a1: 2 }];
  for (const battle of battles) {
    refused(c, () => C.applyBattle(c, battle, 0, sv), `battle ${JSON.stringify(battle)}`);
  }
  for (const s of [undefined, null, 5, 'x', {}, [], [null, null], [undefined, sv[1]], ['x', sv[1]]]) {
    refused(c, () => C.applyBattle(c, b, 0, s), `survivors ${JSON.stringify(s)}`);
  }
  refused(c, () => C.applyBattle(null, b, 0, sv), 'no campaign');
  assert.equal(C.applyBattle(c, b, 0, sv), true, 'still resolvable afterwards');
  refused(c, () => C.applyBattle(c, b, 0, sv), 'the same battle cannot be applied twice');
});

// ---------- settle ----------
test('settle: an army alone in a province takes it', () => {
  const one = () => units('sword', 1);
  const c = setup([[0, 6, one()], [1, 3, one()], [0, 1, one()], [1, 12, one()]]);
  assert.equal(C.settle(c), true);
  assert.equal(c.owner[6], 0, 'neutral province taken');
  assert.equal(c.owner[3], 1, 'enemy province taken');
  assert.equal(c.owner[1], 0);
  assert.equal(c.winner, null);
  assert.equal(c.log.filter(l => /captured/.test(l)).length, 2);
  checkState(c);
});

test('settle: a contested province does not change hands', () => {
  const one = () => units('sword', 1);
  const c = setup([[0, 6, one()], [1, 6, one()], [0, 10, one()], [1, 10, one()]]);
  assert.equal(C.settle(c), true);
  assert.equal(c.owner[6], -1);
  assert.equal(c.owner[10], 1);
  assert.equal(c.winner, null);
});

test('settle: taking the enemy capital wins', () => {
  for (const p of [0, 1]) {
    const c = setup([[p, C.CAPITAL[1 - p], units('sword', 1)], [1 - p, 6, units('cav', 5)]]);
    assert.equal(C.settle(c), true);
    assert.equal(c.winner, p);
    assert.equal(c.owner[C.CAPITAL[1 - p]], p);
    refused(c, () => C.settle(c), 'already decided');
    refused(c, () => C.endTurn(c), 'no new turn after the end');
  }
});

test('settle: both capitals falling in the same turn is a draw', () => {
  const c = setup([[0, 12, units('sword', 1)], [1, 0, units('sword', 1)]]);
  assert.equal(C.settle(c), true);
  assert.equal(c.winner, -1);
  assert.deepEqual([c.owner[0], c.owner[12]], [1, 0]);
  // army order must not matter
  const d = setup([[1, 0, units('sword', 1)], [0, 12, units('sword', 1)]]);
  C.settle(d);
  assert.equal(d.winner, -1);
});

test('settle: no premature elimination (no armies, no gold: still in the game)', () => {
  const c = setup([[1, 6, units('sword', 4)]], { gold: [0, 0] });
  assert.equal(C.settle(c), true);
  assert.equal(c.winner, null, 'red has no army and no gold but still holds its capital');
  assert.equal(C.endTurn(c), true);
  assert.equal(c.gold[0], 4 * C.INCOME);
  assert.equal(C.recruit(c, 0, 0, 'sword'), true, 'income lets them recruit again');
  assert.equal(C.totalUnits(c, 0), 1);
  // both sides wiped out: still nobody wins
  const d = setup([], { gold: [0, 0] });
  C.settle(d);
  assert.equal(d.winner, null);
});

// ---------- endTurn ----------
test('endTurn: income per owned province, turn counter, ready reset, log trimmed', () => {
  const c = C.newCampaign();
  c.owner[6] = 0;
  c.ready = [true, true];
  for (let i = 0; i < 30; i++) c.log.push(`line ${i}`);
  assert.equal(C.endTurn(c), true);
  assert.deepEqual(c.gold, [C.START_GOLD + 5 * C.INCOME, C.START_GOLD + 4 * C.INCOME]);
  assert.equal(c.turn, 2);
  assert.deepEqual(c.ready, [false, false]);
  assert.equal(c.log.length, 12);
  assert.equal(c.log.at(-1), 'line 29');
});

test('endTurn: replenishment only on own soil, capped at full strength', () => {
  const worn = () => [unit('sword', 10), unit('sword', 55), unit('spear', 60), unit('archer', 1), unit('cav', 17),
    unit('cav', 24)];
  const c = setup([[0, 2, worn()], [0, 6, worn()], [0, 10, worn()], [1, 11, worn()], [1, 3, worn()]]);
  assert.equal(C.endTurn(c), true);
  const healed = [unit('sword', 25), unit('sword', 60), unit('spear', 60), unit('archer', 11), unit('cav', 23),
    unit('cav', 24)];
  assert.deepEqual(armyOf(c, 1).units, healed, 'red in red Midvale');
  assert.deepEqual(armyOf(c, 2).units, worn(), 'red in neutral Heartland');
  assert.deepEqual(armyOf(c, 3).units, worn(), 'red in blue Dunemouth');
  assert.deepEqual(armyOf(c, 4).units, healed, 'blue in blue Cinderfen');
  assert.deepEqual(armyOf(c, 5).units, worn(), 'blue in red Southfen');
  for (const type of Object.keys(C.COST)) {
    const d = setup([[0, 0, [unit(type, 1)]]]);
    C.endTurn(d);
    assert.equal(d.armies[0].units[0].men, 1 + Math.ceil(C.REPLENISH * TYPES[type].men), type);
    for (let i = 0; i < 10; i++) C.endTurn(d);
    assert.equal(d.armies[0].units[0].men, TYPES[type].men, `${type} capped`);
  }
});

// ---------- hostile input ----------
test('no mutator throws on garbage; refused calls change nothing (seeded fuzz)', () => {
  const rnd = rng(2026);
  const junk = [undefined, null, true, false, 0, 1, -1, 2, 3, 12, 13, 1.5, NaN, Infinity, -Infinity, 1e21, '', '0', '1',
    'sword', 'cav', 'constructor', '__proto__', 'toString', [], [0], [[], []], {}, { a0: 1, a1: 2 }, { a0: 2, a1: 1 },
    () => 0, Symbol('x'), 10n, [[{ type: 'sword', men: 5 }], [{ type: 'cav', men: 5 }]]];
  const calls = [
    (c, a) => C.recruit(c, a[0], a[1], a[2]),
    (c, a) => C.setMove(c, a[0], a[1], a[2]),
    (c, a) => C.applyBattle(c, a[0], a[1], a[2]),
    (c, a) => C.aiTurn(c, a[0]),
  ];
  // a mid-game campaign: a few AI turns in
  const c = C.newCampaign();
  for (let i = 0; i < 6; i++) { C.aiTurn(c, 0); C.aiTurn(c, 1); playTurn(c, { rnd, noise: 0.5 }); }
  assert.equal(c.winner, null);
  for (let i = 0; i < 6000; i++) {
    const call = pick(rnd, calls), args = [pick(rnd, junk), pick(rnd, junk), pick(rnd, junk)];
    const before = structuredClone(c);
    let out;
    assert.doesNotThrow(() => { out = call(c, args); });
    assert.equal(typeof out, 'boolean');
    if (out === false) assert.deepEqual(c, before);
    checkState(c, 'fuzz');
  }
  // a campaign argument that is not a campaign
  const broken = [...junk, { armies: [], owner: [] }, { armies: [null], owner: [], gold: [], moves: [], log: [] },
    { armies: [{}], owner: [], gold: [], moves: [], log: [] }];
  for (const bad of broken) {
    assert.doesNotThrow(() => {
      assert.equal(C.recruit(bad, 0, 0, 'sword'), false);
      assert.equal(C.setMove(bad, 0, 1, 2), false);
      assert.equal(C.setMove(bad, 0, 1, null), false);
      assert.deepEqual(C.resolveMoves(bad), []);
      assert.equal(C.applyBattle(bad, { a0: 1, a1: 2 }, 0, [[], []]), false);
      assert.equal(C.settle(bad), false);
      assert.equal(C.endTurn(bad), false);
      assert.equal(C.aiTurn(bad, 0), false);
      assert.equal(C.totalUnits(bad, 0), 0);
    }, `campaign #${broken.indexOf(bad)}`);
  }
});

// ---------- AI (P1) ----------
const aiMove = (c, p, id) => (Object.hasOwn(c.moves[p], id) ? c.moves[p][id] : null);

test('AI: recruits at its capital and gives valid orders; refuses bad calls', () => {
  const c = C.newCampaign();
  assert.equal(C.aiTurn(c, 1), true);
  assert.ok(C.totalUnits(c, 1) > 4, 'spent its starting gold');
  assert.ok(c.armies.filter(a => a.owner === 1).every(a => a.prov === 12));
  assert.equal(C.totalUnits(c, 0), 4, 'the other side is untouched');
  assert.deepEqual(c.moves[0], {});
  for (const [id, to] of Object.entries(c.moves[1])) assert.ok(C.ADJ[armyOf(c, +id).prov].includes(to));
  checkState(c);
  for (const p of [2, -1, null, undefined, '1', NaN]) refused(c, () => C.aiTurn(c, p), `player ${String(p)}`);
  c.winner = 0;
  refused(c, () => C.aiTurn(c, 1), 'campaign over');
});

test('AI: deterministic, and repeating a turn\'s orders changes nothing', () => {
  const run = () => {
    const c = C.newCampaign(), rnd = rng(11), trace = [];
    for (let t = 0; t < 60 && c.winner === null; t++) {
      assert.equal(C.aiTurn(c, 0), true);
      assert.equal(C.aiTurn(c, 1), true);
      const once = JSON.stringify(c);
      C.aiTurn(c, 0); C.aiTurn(c, 1);
      assert.equal(JSON.stringify(c), once, `turn ${c.turn}: a second aiTurn must be a no-op`);
      trace.push(once);
      playTurn(c, { rnd, noise: 0.5 });
    }
    return trace;
  };
  assert.deepEqual(run(), run());
});

test('AI: the garrison holds the capital while an enemy is within 2 steps', () => {
  // 8 units would normally march on the enemy capital
  const c = setup([[0, 0, units('sword', 8)], [1, 4, units('sword', 2)], [1, 12, units('sword', 2)]]);
  assert.equal(C.aiTurn(c, 0), true);
  assert.equal(aiMove(c, 0, 1), null, 'enemy at Highwold (2 steps): stay');
  armyOf(c, 2).prov = 6; // 3 steps away: no longer a threat
  assert.equal(C.aiTurn(c, 0), true);
  assert.notEqual(aiMove(c, 0, 1), null, 'threat gone: march');
  // mirrored for the other seat
  const d = setup([[1, 12, units('sword', 8)], [0, 7, units('sword', 2)], [0, 0, units('sword', 2)]]);
  C.aiTurn(d, 1);
  assert.equal(aiMove(d, 1, 1), null);
});

test('AI: the garrison attacks an adjacent enemy only with 1.5x its men', () => {
  const c = setup([[0, 0, units('sword', 3)], [1, 2, units('sword', 2)]]); // 180 vs 120: exactly 1.5x
  C.aiTurn(c, 0);
  assert.equal(aiMove(c, 0, 1), 2, 'attacks');
  armyOf(c, 2).units.push(unit('cav', 1)); // 180 vs 121
  C.aiTurn(c, 0);
  assert.equal(aiMove(c, 0, 1), null, 'not strong enough: the earlier order is withdrawn');
  // strong enough for the neighbour but not for everything near the capital: stay
  const d = setup([[0, 0, units('sword', 3)], [1, 2, units('sword', 1)], [1, 4, units('sword', 2)]]);
  C.aiTurn(d, 0);
  assert.equal(aiMove(d, 0, 1), null);
  // an enemy two steps away is never attacked from the capital
  const e = setup([[0, 0, units('sword', 8)], [1, 4, [unit('sword', 1)]]]);
  C.aiTurn(e, 0);
  assert.equal(aiMove(e, 0, 1), null);
});

test('AI: never walks into a stronger enemy army unless it has 12+ units', () => {
  const garrison = () => units('sword', 6); // 360 men
  const c = setup([[0, 10, units('archer', 8)], [1, 12, garrison()]], { owner: { 10: 0 } }); // 320 men
  C.aiTurn(c, 0);
  assert.notEqual(aiMove(c, 0, 1), 12, '8 units, fewer men: no assault');
  assert.ok([7, 8, 9, 11].includes(aiMove(c, 0, 1)), 'takes an undefended province instead');
  const d = setup([[0, 10, units('cav', 12)], [1, 12, garrison()]], { owner: { 10: 0 } }); // 288 men
  C.aiTurn(d, 0);
  assert.equal(aiMove(d, 0, 1), 12, '12 units: assault regardless');
  const e = setup([[0, 10, units('sword', 8)], [1, 12, garrison()]], { owner: { 10: 0 } }); // 480 men
  C.aiTurn(e, 0);
  assert.equal(aiMove(e, 0, 1), 12, 'stronger: assault');
  // a small army does not blunder into a stronger one on its way to a free province either
  const own = { 1: 0, 2: 0, 4: 0, 5: 0 };
  const f = setup([[0, 4, units('sword', 2)], [1, 6, units('sword', 3)], [1, 7, units('sword', 3)]], { owner: own });
  C.aiTurn(f, 0);
  assert.equal(aiMove(f, 0, 1), 2, 'walks round the stronger armies (toward Saltmarsh via Midvale)');
  const g = setup([[0, 4, units('sword', 2)], [1, 6, units('sword', 3)], [1, 7, units('sword', 3)],
    [1, 5, units('sword', 3)]], { owner: { ...own, 5: 1 } });
  C.aiTurn(g, 0);
  assert.equal(aiMove(g, 0, 1), null, 'every way forward is held by a stronger army: wait');
  g.armies[0].units = units('sword', 3); // equal men: allowed
  C.aiTurn(g, 0);
  assert.notEqual(aiMove(g, 0, 1), null);
});

test('AI: a field army of 5+ returns when the capital is threatened and home is nearer than its target', () => {
  const own = { 4: 1, 5: 0 }; // from Midvale the nearest free province (Heartland) is 2 steps, home is 1
  const c = setup([[0, 2, units('sword', 6)], [1, 4, units('sword', 7)]], { owner: own });
  C.aiTurn(c, 0);
  assert.equal(aiMove(c, 0, 1), 0, 'goes home');
  const d = setup([[0, 2, units('sword', 6)], [1, 12, units('sword', 7)]], { owner: own });
  C.aiTurn(d, 0);
  assert.ok([4, 5].includes(aiMove(d, 0, 1)), 'no threat: carries on');
  const e = setup([[0, 2, units('sword', 4)], [1, 4, units('sword', 7)]], { owner: own });
  C.aiTurn(e, 0);
  assert.notEqual(aiMove(e, 0, 1), 0, 'under 5 units: carries on');
  const f = setup([[0, 2, units('sword', 6)], [1, 4, units('sword', 7)]], { owner: { 4: 1 } });
  C.aiTurn(f, 0);
  assert.equal(aiMove(f, 0, 1), 5, 'a target as near as home: carries on');
});

test('AI: idle small armies join up instead of waiting forever', () => {
  // everything but the enemy capital is red; two armies of 5 cannot assault 12 swords on their own
  const owner = Object.fromEntries(C.PROVS.map((_, i) => [i, i === 12 ? 1 : 0]));
  const c = setup([[0, 9, units('sword', 5)], [0, 11, units('sword', 5)], [1, 12, units('sword', 12)]], { owner });
  C.aiTurn(c, 0);
  assert.equal(aiMove(c, 0, 1), null, 'the rally point (older army) stays');
  assert.equal(aiMove(c, 0, 2), 10, 'the other walks round the enemy capital toward it');
  let assault = false;
  for (let t = 0; t < 6 && !assault; t++) {
    C.aiTurn(c, 0);
    assault = playTurn(c).battles.some(b => b.prov === 12);
  }
  assert.equal(c.armies.filter(a => a.owner === 0).length <= 1, true, 'merged');
  assert.equal(assault, false, '10 swords (600 men) still do not attack 720');
  // with income the AI raises more units, they join, and at 12+ units the host attacks
  c.gold[0] = 2000;
  for (let t = 0; t < 30 && !assault && c.winner === null; t++) {
    C.aiTurn(c, 0);
    assault = playTurn(c).battles.some(b => b.prov === 12);
  }
  assert.equal(assault, true, 'the AI must eventually assault the capital');
});

test('AI: two AI armies that bounce head-on do not bounce forever', () => {
  const c = setup([[0, 4, units('sword', 8)], [1, 7, units('sword', 8)]]);
  C.aiTurn(c, 0); C.aiTurn(c, 1);
  assert.equal(aiMove(c, 0, 1), 7);
  assert.equal(aiMove(c, 1, 2), 4);
  assert.deepEqual(playTurn(c).battles, [], 'first contact: both turn back');
  assert.equal(c.bounced.length, 2);
  C.aiTurn(c, 0); C.aiTurn(c, 1);
  assert.equal([aiMove(c, 0, 1), aiMove(c, 1, 2)].filter(x => x !== null).length, 1, 'exactly one side waits');
  assert.equal(playTurn(c).battles.length, 1, 'second turn: they fight');
});

test('AI: beats a passive opponent from either seat', () => {
  for (const ai of [0, 1]) {
    const c = C.newCampaign();
    for (let t = 0; t < 40 && c.winner === null; t++) {
      assert.equal(C.aiTurn(c, ai), true);
      playTurn(c, { label: `ai seat ${ai}` });
    }
    assert.equal(c.winner, ai, `AI in seat ${ai} must finish the campaign (turn ${c.turn})`);
  }
});

test('AI: an idle enemy stack in the field does not stop it from finishing', () => {
  // Frozen opponent: its garrison plus a big stack parked anywhere 3+ steps from the AI capital.
  // (Inside 2 steps the SPEC rule applies instead: the garrison holds the capital.)
  const hops = from => {
    const d = C.PROVS.map(() => Infinity), q = [from];
    d[from] = 0;
    for (let i = 0; i < q.length; i++) {
      for (const v of C.ADJ[q[i]]) if (d[v] === Infinity) { d[v] = d[q[i]] + 1; q.push(v); }
    }
    return d;
  };
  for (const ai of [0, 1]) {
    const foe = 1 - ai, far = hops(C.CAPITAL[ai]);
    for (let prov = 0; prov < C.PROVS.length; prov++) {
      if (far[prov] < 3 || prov === C.CAPITAL[foe]) continue;
      for (const stack of [units('sword', 12), units('cav', 1)]) {
        const c = C.newCampaign(), label = `ai seat ${ai}, ${stack.length} units parked at ${prov}`;
        c.armies.push({ id: c.nextId++, owner: foe, prov, units: stack });
        c.owner[prov] = foe;
        for (let t = 0; t < 60 && c.winner === null; t++) {
          assert.equal(C.aiTurn(c, ai), true, label);
          playTurn(c, { label });
        }
        assert.equal(c.winner, ai, `${label}: no result by turn ${c.turn}`);
      }
    }
  }
});

test('AI: keeps assaulting an opponent that only turtles in its capital', () => {
  for (const ai of [0, 1]) {
    const c = C.newCampaign(), foe = 1 - ai;
    let assaults = 0;
    for (let t = 0; t < 120 && c.winner === null; t++) {
      for (let i = 0; i < 4; i++) C.recruit(c, foe, C.CAPITAL[foe], 'sword');
      assert.equal(C.aiTurn(c, ai), true);
      const { battles } = playTurn(c, { label: `turtle, ai seat ${ai}` });
      assaults += battles.filter(b => b.prov === C.CAPITAL[foe]).length;
    }
    assert.ok(c.winner === ai || assaults >= 3, `seat ${ai}: winner ${c.winner}, ${assaults} assaults in ${c.turn} turns`);
  }
});

test('AI vs AI: 200-turn soak with auto-resolved battles (no throw, sane gold, unit cap, no stall)', () => {
  let finished = 0, battles = 0;
  for (let seed = 0; seed < 40; seed++) {
    // seed 0 is the perfectly mirrored game (no noise); the others get seeded battle luck
    const rnd = rng(seed), noise = seed === 0 ? 0 : 0.6, label = `soak seed ${seed}`;
    const c = C.newCampaign();
    let lastEvent = 0;
    for (let t = 1; t <= 200 && c.winner === null; t++) {
      assert.equal(C.aiTurn(c, 0), true, label);
      assert.equal(C.aiTurn(c, 1), true, label);
      checkState(c, label);
      const r = playTurn(c, { rnd, noise, label });
      battles += r.battles.length;
      if (r.battles.length || r.captured) lastEvent = t;
      assert.ok(c.log.length <= 12 + 40, `${label}: log grows without bound`);
      assert.ok(t - lastEvent < 60, `${label}: nothing happened for 60 turns (turn ${t})`);
    }
    if (c.winner !== null) finished++;
  }
  assert.ok(battles > 40, `only ${battles} battles in 40 campaigns`);
  assert.ok(finished >= 30, `only ${finished} of 40 campaigns reached a result`);
});

test('AI vs erratic opponent: 200-turn soak with random legal and illegal orders', () => {
  const types = [...Object.keys(C.COST), 'constructor', '__proto__', 'elephant'];
  for (let seed = 100; seed < 130; seed++) {
    const rnd = rng(seed), label = `erratic seed ${seed}`, ai = seed % 2, foe = 1 - ai;
    const c = C.newCampaign();
    for (let t = 1; t <= 200 && c.winner === null; t++) {
      for (let i = Math.floor(rnd() * 6); i > 0; i--) {
        if (rnd() < 0.4) C.recruit(c, foe, Math.floor(rnd() * 15) - 1, pick(rnd, types));
        else {
          const a = pick(rnd, c.armies);
          const to = rnd() < 0.8 && a ? pick(rnd, C.ADJ[a.prov]) : rnd() < 0.5 ? null : Math.floor(rnd() * 15) - 1;
          C.setMove(c, foe, a ? a.id : 0, to);
        }
      }
      assert.equal(C.aiTurn(c, ai), true, label);
      checkState(c, label);
      playTurn(c, { rnd, noise: 0.8, label });
    }
  }
});
