// Battle AI for a bot-controlled side. Deterministic, and it only acts through giveOrder,
// so it can do nothing a human player could not.
import { W, H, TICK, TYPES, giveOrder } from './sim.js';

const THINK_TICKS = 10;        // act every 0.5 s of sim time
const RETARGET_TICKS = 60;     // cavalry reconsiders its target every 3 s
const SPEAR_GUARD = 220;       // spears go for enemy cavalry this close
const DANGER = 70;             // archers give ground to melee troops this close ...
const RETREAT = 110;           // ... by about this much
const CORNERED = 45;           // a shorter retreat is not worth turning around for
const MARGIN = 20;             // retreat destinations stay this far inside the field
const STICKY = 20;             // infantry keeps its target unless another is this much nearer
const RESERVE_TICKS = 500;     // cavalry is held back for at most 25 s ...
const RESERVE_ALARM = 260;     // ... and is released at once by an enemy this close
const ESCORT = 90;             // in reserve it rides this far behind the nearest friendly foot

const memory = new WeakMap();  // battle -> per-side bot state

const live = r => r.state !== 'dead' && r.state !== 'rout';
const gap = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
const hasAmmo = r => !!TYPES[r.type].ranged && r.ammo > 0;

function stateFor(battle, side) {
  let pair = memory.get(battle);
  if (!pair) { pair = [null, null]; memory.set(battle, pair); }
  if (!pair[side]) pair[side] = { next: 0, released: false, cav: new Map() };
  return pair[side];
}

// Nearest of `list` to r; ties go to the earlier regiment so both sides break them alike.
function nearest(r, list, within = Infinity) {
  let best = null, bd = within;
  for (const f of list) {
    const d = gap(r, f);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

function attack(battle, side, r, foe) {
  if (!foe) return;
  if (r.order && r.order.t === 'attack' && r.order.target === foe.id) return;
  giveOrder(battle, side, [r.id], { t: 'attack', target: foe.id });
}

function infantry(battle, side, r, foes) {
  const current = r.order && r.order.t === 'attack' ? foes.find(f => f.id === r.order.target) : null;
  if (current && r.state === 'fighting') return;            // never turn its back on a melee
  let pick = nearest(r, foes);
  if (current && pick && gap(r, current) <= gap(r, pick) + STICKY) pick = current;
  if (r.type === 'spear') {
    pick = nearest(r, foes.filter(f => f.type === 'cav'), SPEAR_GUARD) || pick;
  }
  attack(battle, side, r, pick);
}

// Whole units measured from the field centre, rounded half away from zero, so the two sides of a
// mirrored battle get exactly mirrored destinations.
const whole = (v, limit) => Math.sign(v) * Math.min(limit, Math.round(Math.abs(v)));

// A point about RETREAT straight away from the threat, or null when the field edge leaves no room.
function retreatSpot(r, threat) {
  const d = gap(r, threat);
  // Standing on top of each other: fall back toward the own table edge.
  const ux = d > 0.01 ? (r.x - threat.x) / d : (r.owner === 0 ? -1 : 1);
  const uy = d > 0.01 ? (r.y - threat.y) / d : 0;
  const x = W / 2 + whole(r.x - W / 2 + ux * RETREAT, W / 2 - MARGIN);
  const y = H / 2 + whole(r.y - H / 2 + uy * RETREAT, H / 2 - MARGIN);
  return gap(r, { x, y }) >= CORNERED ? { x, y } : null;
}

function archer(battle, side, r, foes) {
  if (r.order && r.order.t === 'move') return;              // finish the retreat already under way
  // Enemy archers that can still shoot are no reason to run: they hit just as hard from afar.
  const threat = nearest(r, foes.filter(f => !hasAmmo(f)), DANGER);
  const spot = threat && retreatSpot(r, threat);
  if (spot) { giveOrder(battle, side, [r.id], { t: 'move', x: spot.x, y: spot.y }); return; }
  const range = TYPES[r.type].range;
  let pick = null;
  for (const f of foes) {
    if (gap(r, f) > range) continue;
    if (!pick || f.men < pick.men) pick = f;                // concentrate fire on the weakest
  }
  attack(battle, side, r, pick || nearest(r, foes));
}

// Cavalry waits in reserve until the lines have met: fresh archers shoot a lone charge to pieces.
// It is released by the first fighting anywhere, by a nearby enemy, when it is all that is left,
// or after RESERVE_TICKS, so holding back can never stall a battle.
function released(mine, foes, tick) {
  return tick >= RESERVE_TICKS
    || mine.every(r => r.type === 'cav')
    || mine.some(r => r.state === 'fighting') || foes.some(f => f.state === 'fighting');
}

// Reserve cavalry keeps its own row but follows the advance, so it is at hand when released.
function escort(battle, side, r, mine) {
  const anchor = nearest(r, mine.filter(m => m.type !== 'cav'));
  if (!anchor) return;
  const x = anchor.x + (side === 0 ? -ESCORT : ESCORT);
  if (Math.abs(x - r.x) < 20) return;
  giveOrder(battle, side, [r.id], { t: 'move', x, y: r.y, face: side === 0 ? 0 : Math.PI });
}

function cavalry(battle, side, r, foes, st, tick, mine) {
  if (!st.released && nearest(r, foes, RESERVE_ALARM)) st.released = true;
  if (!st.released) { escort(battle, side, r, mine); return; }
  const soft = foes.filter(f => f.type !== 'spear');        // spears halve cavalry damage: last resort
  const mem = st.cav.get(r.id);
  const ordered = r.order && r.order.t === 'attack' ? r.order.target : null;
  const target = mem && ordered === mem.target ? foes.find(f => f.id === mem.target) : null;
  if (target && r.state !== 'idle') {
    if (tick - mem.at < RETARGET_TICKS) return;
    // Locked in melee it stays, unless it is stuck on spears while softer targets exist.
    if (r.state === 'fighting' && (target.type !== 'spear' || !soft.length)) return;
  }
  const pick = nearest(r, foes.filter(f => f.type === 'archer'))
    || nearest(r, soft.filter(f => f.state === 'fighting' && f.engaged !== r.id))   // busy elsewhere: flank it
    || nearest(r, soft)
    || nearest(r, foes);
  if (!pick) return;
  attack(battle, side, r, pick);
  st.cav.set(r.id, { target: pick.id, at: tick });
}

function think(battle, side) {
  if (!battle || typeof battle !== 'object' || !Array.isArray(battle.regs) || battle.over) return;
  if (side !== 0 && side !== 1) return;
  const st = stateFor(battle, side);
  const tick = Math.round(battle.time / TICK);
  if (!(tick >= st.next)) return;
  st.next = tick + THINK_TICKS;
  const known = r => !!r && typeof r === 'object' && Object.hasOwn(TYPES, r.type) && live(r);
  const mine = battle.regs.filter(r => known(r) && r.owner === side);
  const foes = battle.regs.filter(r => known(r) && r.owner === 1 - side);
  if (!mine.length || !foes.length) return;
  st.released = st.released || released(mine, foes, tick);
  for (const r of mine) {
    if (hasAmmo(r)) archer(battle, side, r, foes);
    else if (r.type === 'cav') cavalry(battle, side, r, foes, st, tick, mine);
    else infantry(battle, side, r, foes);
  }
}

// Call once per sim tick for an AI-controlled side (0 or 1).
export function botThink(battle, side) {
  try { think(battle, side); } catch { /* a bot bug must never take a room down */ }
}
