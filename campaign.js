// Turn-based campaign rules. Pure logic, no networking.
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

export function newCampaign() {
  const owner = PROVS.map((_, i) => [0, 1, 2, 3].includes(i) ? 0 : [9, 10, 11, 12].includes(i) ? 1 : -1);
  const full = type => ({ type, men: TYPES[type].men });
  const start = () => ['sword', 'sword', 'spear', 'archer'].map(full);
  return {
    owner, turn: 1, gold: [START_GOLD, START_GOLD], winner: null, log: ['The campaign begins.'],
    armies: [{ id: 1, owner: 0, prov: 0, units: start() }, { id: 2, owner: 1, prov: 12, units: start() }],
    nextId: 3, moves: [{}, {}], ready: [false, false],
  };
}

export const totalUnits = (c, p) => c.armies.filter(a => a.owner === p).reduce((s, a) => s + a.units.length, 0);

export function recruit(c, p, prov, type) {
  if (!(type in COST) || c.owner[prov] !== p || c.winner !== null) return false;
  if (c.gold[p] < COST[type] || totalUnits(c, p) >= MAX_UNITS) return false;
  let a = c.armies.find(x => x.owner === p && x.prov === prov);
  if (!a) { a = { id: c.nextId++, owner: p, prov, units: [] }; c.armies.push(a); }
  a.units.push({ type, men: TYPES[type].men });
  c.gold[p] -= COST[type];
  return true;
}

export function setMove(c, p, armyId, to) {
  const a = c.armies.find(x => x.id === armyId && x.owner === p);
  if (!a || c.winner !== null) return false;
  if (to === null) { delete c.moves[p][armyId]; return true; }
  if (!ADJ[a.prov].includes(to)) return false;
  c.moves[p][armyId] = to; return true;
}

// Apply both players' orders. Armies that would cross paths turn back.
// Returns the battles to fight (province + the two armies).
export function resolveMoves(c) {
  const mv = (a) => c.moves[a.owner][a.id];
  const bounced = new Set();
  for (const a of c.armies) for (const b of c.armies) {
    if (a.owner === 0 && b.owner === 1 && mv(a) === b.prov && mv(b) === a.prov) {
      bounced.add(a.id); bounced.add(b.id);
      c.log.push(`Armies crossing between ${PROVS[a.prov].name} and ${PROVS[b.prov].name} turned back.`);
    }
  }
  for (const a of c.armies) { const to = mv(a); if (to !== undefined && !bounced.has(a.id)) a.prov = to; }
  c.moves = [{}, {}];
  // merge same-owner armies sharing a province
  const merged = [];
  for (const a of c.armies) {
    const m = merged.find(x => x.owner === a.owner && x.prov === a.prov);
    if (m) m.units.push(...a.units); else merged.push(a);
  }
  c.armies = merged;
  const battles = [];
  PROVS.forEach((_, prov) => {
    const a0 = c.armies.find(a => a.owner === 0 && a.prov === prov), a1 = c.armies.find(a => a.owner === 1 && a.prov === prov);
    if (a0 && a1) battles.push({ prov, a0: a0.id, a1: a1.id });
  });
  return battles;
}

// survivors: [side0 units, side1 units]; winner: 0 | 1 | -1 (draw)
export function applyBattle(c, battle, winner, survivors) {
  const arm = [battle.a0, battle.a1].map(id => c.armies.find(a => a.id === id));
  const side = ['Red', 'Blue'];
  for (let s = 0; s < 2; s++) {
    if (winner === s && survivors[s].length) arm[s].units = survivors[s];
    else c.armies = c.armies.filter(a => a !== arm[s]);
  }
  c.log.push(winner === -1 ? `Battle at ${PROVS[battle.prov].name}: both armies destroyed.`
    : `Battle at ${PROVS[battle.prov].name}: ${side[winner]} victorious.`);
}

// Provinces held by an unopposed army change hands. Taking a capital wins.
export function settle(c) {
  for (const a of c.armies) {
    if (c.owner[a.prov] === a.owner) continue;
    c.owner[a.prov] = a.owner;
    c.log.push(`${['Red', 'Blue'][a.owner]} captured ${PROVS[a.prov].name}.`);
    const ci = CAPITAL.indexOf(a.prov);
    if (ci >= 0 && ci !== a.owner) c.winner = a.owner;
  }
  // a player with no armies and no gold to recruit loses
  for (const p of [0, 1]) if (c.winner === null && !c.armies.some(a => a.owner === p) && c.gold[p] < Math.min(...Object.values(COST)))
    c.winner = 1 - p;
}

export function endTurn(c) {
  for (const p of [0, 1]) c.gold[p] += INCOME * c.owner.filter(o => o === p).length;
  c.turn++; c.ready = [false, false];
  if (c.log.length > 12) c.log = c.log.slice(-12);
}

function bfs(from, goal) {
  const prev = new Map([[from, null]]), q = [from];
  while (q.length) {
    const u = q.shift();
    if (goal(u) && u !== from) { let n = u; while (prev.get(n) !== from) n = prev.get(n); return n; }
    for (const v of ADJ[u]) if (!prev.has(v)) { prev.set(v, u); q.push(v); }
  }
  return null;
}

// Simple campaign AI: build up at the capital, then push on the nearest soft target / enemy capital.
export function aiTurn(c, p) {
  const cap = CAPITAL[p], enemyCap = CAPITAL[1 - p];
  const order = ['sword', 'spear', 'archer', 'sword', 'cav'];
  for (let i = 0; totalUnits(c, p) < MAX_UNITS && i < 20; i++) if (!recruit(c, p, cap, order[(totalUnits(c, p)) % order.length])) break;
  for (const a of c.armies.filter(x => x.owner === p)) {
    const enemyAt = prov => c.armies.some(x => x.owner !== p && x.prov === prov);
    let step;
    if (a.units.length >= 8) step = bfs(a.prov, n => n === enemyCap);
    else if (a.prov !== cap || a.units.length >= 5)
      step = bfs(a.prov, n => c.owner[n] !== p && !enemyAt(n));
    if (step != null) setMove(c, p, a.id, step);
  }
}
