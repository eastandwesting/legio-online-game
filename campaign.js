// Turn-based campaign rules. Pure logic: no networking, no timers, no randomness.
// Every mutator validates its arguments and returns false (without mutating) on bad input.
import { TYPES } from './sim.js';

export const PROVS = [
  { name: 'Castra Prima', x: 70,  y: 300 }, // 0  red capital
  { name: 'Northmark',    x: 210, y: 110 }, // 1
  { name: 'Midvale',      x: 200, y: 300 }, // 2
  { name: 'Southfen',     x: 210, y: 490 }, // 3
  { name: 'Highwold',     x: 370, y: 190 }, // 4
  { name: 'Rivergate',    x: 370, y: 410 }, // 5
  { name: 'Heartland',    x: 500, y: 300 }, // 6
  { name: 'Ironridge',    x: 630, y: 190 }, // 7
  { name: 'Saltmarsh',    x: 630, y: 410 }, // 8
  { name: 'Eastwatch',    x: 790, y: 110 }, // 9
  { name: 'Dunemouth',    x: 800, y: 300 }, // 10
  { name: 'Cinderfen',    x: 790, y: 490 }, // 11
  { name: 'Aurum Magna',  x: 930, y: 300 }, // 12 blue capital
];
export const CAPITAL = [0, 12];
export const EDGES = [[0,1],[0,2],[0,3],[1,2],[2,3],[1,4],[2,4],[2,5],[3,5],[4,6],[5,6],[4,7],[6,7],[5,8],[6,8],
  [7,9],[7,10],[8,10],[8,11],[9,10],[10,11],[9,12],[10,12],[11,12]];
export const ADJ = PROVS.map(() => []);
for (const [a, b] of EDGES) { ADJ[a].push(b); ADJ[b].push(a); }

export const COST = { sword: 100, spear: 110, archer: 120, cav: 200 };
export const START_GOLD = 400, INCOME = 40, MAX_UNITS = 16;
export const REPLENISH = 0.25; // share of full strength a unit regains per turn on home soil

const UNIT_ORDER = ['sword', 'spear', 'archer', 'cav']; // regroup order
const SIDE = ['Red', 'Blue'];
const LOG_KEEP = 12;

// ---------- validation helpers ----------
const isSide = p => p === 0 || p === 1;
const isProv = i => Number.isInteger(i) && i >= 0 && i < PROVS.length;
// Full strength of a unit type; 0 for anything that is not a real type (own keys only).
const fullMen = type => {
  const known = typeof type === 'string' && Object.hasOwn(TYPES, type) && Number.isInteger(TYPES[type].men);
  return known ? TYPES[type].men : 0;
};
// Own keys only: 'constructor' or '__proto__' must never pass as a unit type.
const isType = type => typeof type === 'string' && Object.hasOwn(COST, type) && fullMen(type) >= 1;
const isArmy = a => !!a && typeof a === 'object' && Array.isArray(a.units);
const isCamp = c => !!c && typeof c === 'object' && Array.isArray(c.armies) && c.armies.every(isArmy) &&
  Array.isArray(c.owner) && Array.isArray(c.gold) && Array.isArray(c.moves) && Array.isArray(c.log);
const menOf = a => a.units.reduce((s, u) => s + u.men, 0);

export function newCampaign() {
  const owner = PROVS.map((_, i) => [0, 1, 2, 3].includes(i) ? 0 : [9, 10, 11, 12].includes(i) ? 1 : -1);
  const full = type => ({ type, men: TYPES[type].men });
  const start = () => ['sword', 'sword', 'spear', 'archer'].map(full);
  return {
    owner, turn: 1, gold: [START_GOLD, START_GOLD], winner: null, log: ['The campaign begins.'],
    armies: [{ id: 1, owner: 0, prov: 0, units: start() }, { id: 2, owner: 1, prov: 12, units: start() }],
    nextId: 3, moves: [{}, {}], ready: [false, false],
    bounced: [], // ids of armies turned back in the last resolveMoves (read by the AI only)
  };
}

export function totalUnits(c, p) {
  if (!isCamp(c)) return 0;
  return c.armies.reduce((s, a) => (a.owner === p ? s + a.units.length : s), 0);
}

export function recruit(c, p, prov, type) {
  if (!isCamp(c) || c.winner !== null || !isSide(p) || !isProv(prov) || !isType(type)) return false;
  if (c.owner[prov] !== p) return false;
  if (!(c.gold[p] >= COST[type]) || totalUnits(c, p) >= MAX_UNITS) return false;
  let a = c.armies.find(x => x.owner === p && x.prov === prov);
  if (!a) { a = { id: c.nextId++, owner: p, prov, units: [] }; c.armies.push(a); }
  a.units.push({ type, men: fullMen(type) });
  c.gold[p] -= COST[type];
  return true;
}

// Order an army to march to an adjacent province; to === null cancels the march.
export function setMove(c, p, armyId, to) {
  if (!isCamp(c) || c.winner !== null || !isSide(p) || !Number.isInteger(armyId)) return false;
  const a = c.armies.find(x => x.id === armyId && x.owner === p);
  if (!a || !c.moves[p] || typeof c.moves[p] !== 'object') return false;
  if (to === null) { delete c.moves[p][armyId]; return true; }
  if (!isProv(to) || !isProv(a.prov) || !ADJ[a.prov].includes(to)) return false;
  c.moves[p][armyId] = to;
  return true;
}

// The pending march of an army, re-validated: an order that is not a real adjacent step is ignored.
function marchOf(c, a) {
  const orders = c.moves[a.owner];
  if (!orders || typeof orders !== 'object' || !Object.hasOwn(orders, a.id) || !isProv(a.prov)) return null;
  const to = orders[a.id];
  return isProv(to) && ADJ[a.prov].includes(to) ? to : null;
}

// Apply both players' orders. Armies that would cross paths turn back.
// Returns the battles to fight: {prov, a0, a1, defender}; defender = the province owner (0 | 1) before
// this turn's captures, or null for a neutral province.
export function resolveMoves(c) {
  if (!isCamp(c) || c.winner !== null) return [];
  const dest = new Map();
  for (const a of c.armies) { const to = marchOf(c, a); if (to !== null) dest.set(a.id, to); }
  const bounced = new Set();
  for (const a of c.armies) for (const b of c.armies) {
    if (a.owner === 0 && b.owner === 1 && dest.get(a.id) === b.prov && dest.get(b.id) === a.prov) {
      bounced.add(a.id); bounced.add(b.id);
      c.log.push(`Armies crossing between ${PROVS[a.prov].name} and ${PROVS[b.prov].name} turned back.`);
    }
  }
  for (const a of c.armies) if (dest.has(a.id) && !bounced.has(a.id)) a.prov = dest.get(a.id);
  c.moves = [{}, {}];
  // merge same-owner armies sharing a province (the earlier army keeps its id)
  const merged = [];
  for (const a of c.armies) {
    const m = merged.find(x => x.owner === a.owner && x.prov === a.prov);
    if (m) m.units.push(...a.units); else merged.push(a);
  }
  c.armies = merged;
  c.bounced = merged.filter(a => bounced.has(a.id)).map(a => a.id);
  const battles = [];
  for (let prov = 0; prov < PROVS.length; prov++) {
    const a0 = c.armies.find(a => a.owner === 0 && a.prov === prov);
    const a1 = c.armies.find(a => a.owner === 1 && a.prov === prov);
    const defender = isSide(c.owner[prov]) ? c.owner[prov] : null;
    if (a0 && a1) battles.push({ prov, a0: a0.id, a1: a1.id, defender });
  }
  return battles;
}

// Pool the men of each unit type and re-form full-strength units plus at most one remainder unit.
// Men per type are conserved; unknown types and empty units are dropped. Order: sword, spear, archer, cav.
export function regroup(units) {
  if (!Array.isArray(units)) return [];
  const pool = new Map(UNIT_ORDER.map(type => [type, 0]));
  for (const u of units) {
    if (!u || typeof u !== 'object' || !pool.has(u.type)) continue;
    // numbers only: Math.floor would throw on a Symbol or BigInt
    const full = fullMen(u.type), men = typeof u.men === 'number' ? Math.floor(u.men) : 0;
    // no unit holds more than its full strength: also keeps the output no longer than the input
    if (full >= 1 && men >= 1) pool.set(u.type, pool.get(u.type) + Math.min(men, full));
  }
  const out = [];
  for (const type of UNIT_ORDER) {
    const full = fullMen(type);
    let men = pool.get(type);
    for (; full >= 1 && men >= full; men -= full) out.push({ type, men: full });
    if (men > 0) out.push({ type, men });
  }
  return out;
}

// battle: an entry returned by resolveMoves; winner: 0 | 1 | -1 (draw); survivors: [side0 units, side1 units].
// The loser's army is removed, a draw removes both, the winner keeps its regrouped survivors.
export function applyBattle(c, battle, winner, survivors) {
  if (!isCamp(c) || !battle || typeof battle !== 'object') return false;
  if (winner !== 0 && winner !== 1 && winner !== -1) return false;
  if (winner !== -1 && (!Array.isArray(survivors) || !Array.isArray(survivors[winner]))) return false;
  const arm = [battle.a0, battle.a1].map((id, s) => c.armies.find(a => a.id === id && a.owner === s));
  if (!arm[0] || !arm[1] || arm[0].prov !== arm[1].prov || !isProv(arm[0].prov)) return false;
  const kept = winner === -1 ? [] : regroup(survivors[winner]);
  if (kept.length) arm[winner].units = kept;
  c.armies = c.armies.filter(a => (a !== arm[0] && a !== arm[1]) || (a === arm[winner] && kept.length > 0));
  const result = winner === -1 ? 'both armies destroyed' : `${SIDE[winner]} victorious`;
  c.log.push(`Battle at ${PROVS[arm[0].prov].name}: ${result}.`);
  return true;
}

// An army alone in a province takes it. Taking the enemy capital wins; both capitals falling in the
// same turn is a draw. A player without armies is NOT out: they still earn income and can recruit.
export function settle(c) {
  if (!isCamp(c) || c.winner !== null) return false;
  const fallen = [false, false]; // fallen[p]: p's capital was taken this turn
  for (const a of c.armies) {
    if (!isSide(a.owner) || !isProv(a.prov) || !a.units.length || c.owner[a.prov] === a.owner) continue;
    if (c.armies.some(b => b.owner !== a.owner && b.prov === a.prov)) continue; // contested: nobody takes it
    c.owner[a.prov] = a.owner;
    c.log.push(`${SIDE[a.owner]} captured ${PROVS[a.prov].name}.`);
    if (a.prov === CAPITAL[1 - a.owner]) fallen[1 - a.owner] = true;
  }
  if (fallen[0] && fallen[1]) {
    c.winner = -1;
    c.log.push('Both capitals have fallen: the campaign is a draw.');
  } else if (fallen[0] || fallen[1]) {
    c.winner = fallen[0] ? 1 : 0;
    c.log.push(`${SIDE[c.winner]} wins the campaign.`);
  }
  return true;
}

// Income, then replenishment of units standing on their own soil, then the next turn begins.
export function endTurn(c) {
  if (!isCamp(c) || c.winner !== null) return false;
  for (const p of [0, 1]) c.gold[p] += INCOME * c.owner.filter(o => o === p).length;
  for (const a of c.armies) {
    if (!isSide(a.owner) || c.owner[a.prov] !== a.owner) continue;
    for (const u of a.units) {
      const full = fullMen(u.type);
      if (full >= 1) u.men = Math.min(full, u.men + Math.ceil(REPLENISH * full));
    }
  }
  c.turn++; c.ready = [false, false];
  if (c.log.length > LOG_KEEP) c.log = c.log.slice(-LOG_KEEP);
  return true;
}

// ---------- campaign AI ----------
const AI_BUILD = ['sword', 'spear', 'archer', 'sword', 'cav'];

// Hop counts between all provinces (the map is small and fixed).
const DIST = PROVS.map((_, from) => {
  const d = PROVS.map(() => Infinity), q = [from];
  d[from] = 0;
  for (let i = 0; i < q.length; i++) {
    for (const v of ADJ[q[i]]) if (d[v] === Infinity) { d[v] = d[q[i]] + 1; q.push(v); }
  }
  return d;
});

// Breadth-first search from `from` to the nearest other province matching `goal`, walking only through
// provinces that pass `open`. Returns {step, dist} (step = first province on the way) or null.
function route(from, goal, open) {
  const prev = new Map([[from, -1]]), hops = new Map([[from, 0]]), q = [from];
  for (let i = 0; i < q.length; i++) {
    const u = q[i];
    if (u !== from && goal(u)) {
      let n = u;
      while (prev.get(n) !== from) n = prev.get(n);
      return { step: n, dist: hops.get(u) };
    }
    for (const v of ADJ[u]) {
      if (!prev.has(v) && open(v)) { prev.set(v, u); hops.set(v, hops.get(u) + 1); q.push(v); }
    }
  }
  return null;
}

// Largest army first: units, then men, then the older army. A total order keeps the AI deterministic.
const bigger = (x, y) => y.units.length - x.units.length || menOf(y) - menOf(x) || x.id - y.id;

// Garrison of a threatened capital: hold, unless an adjacent enemy can be crushed (1.5x the men of
// everything threatening the capital). Returns the province to attack or null.
function sortie(ctx, men) {
  const adjacent = ctx.threats.filter(f => DIST[ctx.cap][f.prov] === 1);
  const total = ctx.threats.reduce((s, f) => s + menOf(f), 0);
  if (!adjacent.length || men < 1.5 * total) return null;
  return adjacent.sort(bigger)[0].prov;
}

// Where a roaming army goes: {step, dist} or null to stand still.
function fieldGoal(ctx, a, open, foeMen) {
  const { c, p, cap } = ctx;
  const n = a.units.length;
  const roams = a.prov !== cap || n >= 5; // a small garrison stays home and builds up
  let goal = n >= 8 ? route(a.prov, x => x === CAPITAL[1 - p], open) : null;
  if (!goal && roams) goal = route(a.prov, x => c.owner[x] !== p && foeMen(x) === 0, open);
  // defend the capital when home is nearer than the objective
  if (a.prov !== cap && n >= 5 && ctx.threats.length && DIST[a.prov][cap] < (goal ? goal.dist : Infinity)) {
    goal = route(a.prov, x => x === cap, open) || goal;
  }
  // nothing left to take: join the largest army, so that small armies cannot idle forever
  if (!goal && roams && ctx.rally && ctx.rally !== a) goal = route(a.prov, x => x === ctx.rally.prov, open);
  return goal;
}

function aiStep(ctx, a) {
  const { c, p, foes } = ctx;
  const n = a.units.length, men = menOf(a);
  const foeMen = prov => foes.reduce((s, f) => (f.prov === prov ? s + menOf(f) : s), 0);
  // never walk into a stronger enemy army, unless this is a host of 12+ units
  const open = prov => n >= 12 || foeMen(prov) <= men;
  let step;
  if (a.prov === ctx.cap && ctx.threats.length) step = sortie(ctx, men);
  else { const goal = fieldGoal(ctx, a, open, foeMen); step = goal ? goal.step : null; }
  // Two armies that turned each other back last turn would do so forever (AI against AI):
  // on alternate turns one side waits instead of attacking again.
  if (step !== null && foeMen(step) > 0 && ctx.bounced.has(a.id) && (c.turn + p) % 2 === 1) return null;
  return step;
}

function aiOrders(c, p) {
  const cap = CAPITAL[p];
  for (let i = 0; i < MAX_UNITS; i++) {
    if (!recruit(c, p, cap, AI_BUILD[totalUnits(c, p) % AI_BUILD.length])) break;
  }
  const sound = a => isProv(a.prov) && a.units.length > 0;
  const mine = c.armies.filter(a => a.owner === p && sound(a));
  const foes = c.armies.filter(a => a.owner === 1 - p && sound(a));
  const ctx = {
    c, p, cap, foes,
    threats: foes.filter(f => DIST[cap][f.prov] <= 2),
    rally: [...mine].sort(bigger)[0] || null,
    bounced: new Set(Array.isArray(c.bounced) ? c.bounced : []),
  };
  // a null step also cancels any earlier order, so calling aiTurn twice in a turn is harmless
  for (const a of mine) setMove(c, p, a.id, aiStep(ctx, a));
}

// Campaign AI for player p: recruit at the capital, then give every army its march for this turn.
// Deterministic. Returns true when the orders were given; never throws.
export function aiTurn(c, p) {
  if (!isCamp(c) || c.winner !== null || !isSide(p)) return false;
  try { aiOrders(c, p); return true; } catch { return false; }
}
