// Authoritative battle simulation. Pure logic: no networking, no clock, no randomness.
//
// Fairness: step() resolves a tick simultaneously. Every decision is planned from the state at the
// start of the tick and then applied to all regiments together, so array order gives no advantage.
// Positions live on a 2^-20 grid measured from the field centre; that makes mirroring a battle
// (x -> W - x) exact in floating point, so a mirrored battle stays mirrored instead of drifting.

export const W = 1600, H = 900;
export const TICK = 0.05;
export const BATTLE_TIME_LIMIT = 300; // seconds of sim time

const freeze = Object.freeze;
export const TYPES = freeze({
  sword:  freeze({ name: 'Shortsword Infantry', men: 60, speed: 46,  range: 16,  dps: 0.040, armor: 0.30, ranged: false }),
  spear:  freeze({ name: 'Spear Phalanx',       men: 60, speed: 38,  range: 18,  dps: 0.030, armor: 0.35, ranged: false, antiCav: 2 }),
  archer: freeze({ name: 'Archers',             men: 40, speed: 52,  range: 170, dps: 0.026, armor: 0.05, ranged: true, ammo: 30, meleeDps: 0.008, meleeRange: 16 }),
  cav:    freeze({ name: 'Heavy Cavalry',       men: 24, speed: 110, range: 18,  dps: 0.070, armor: 0.20, ranged: false, charge: 1.8 }),
});

// Both sides of a quick battle field the same army.
const DEFAULT_ARMY = freeze(['sword', 'sword', 'sword', 'spear', 'spear', 'archer', 'archer', 'cav', 'cav']);

const MAX_PER_SIDE = 20;
const HW = W / 2, HH = H / 2;
const GRID = 2 ** 20;
const EDGE = 10;             // move orders stay this far inside the field
const ARRIVE = 4;            // a march ends within this distance of its destination ...
const STALL_TICKS = 20;      // ... or after 1 s without getting closer (the spot is taken or blocked)
const PROGRESS = 0.1;        // getting closer means by at least this much
const ACQUIRE = 40;          // idle melee regiments pick up enemies this close
const MELEE_SLACK = 12;      // melee connects at range + slack ...
const MELEE_HOLD = 6;        // ... and keeps closing to range + hold, so a small push does not break contact
const SHOOT_HOLD = 0.95;     // archers close to 95% of their range for the same reason
const GAP_FRIEND = 30;       // friendly regiments are pushed apart to this distance
const GAP_ENEMY = 20;        // enemies only to this: it must stay below every melee hold distance
const SLIDE = 0.5;           // sideways share of a push between friends when one of them is on the move
const REAR = 2.3, FLANK = 1.2;   // radians off the target's facing
const CHARGE_TIME = 1;       // seconds of charge bonus at the start of a melee
const ROUT_TIME = 20;        // seconds a routing regiment runs before it is gone
const ROUT_MEN = 0.15;       // a regiment breaks below this share of its starting strength
const DRAW_MARGIN = 0.02;        // timeout without a defender: a gap in surviving share under this is a draw
const DEFENDER_EDGE = 0.75;      // timeout with a defender: it holds unless its share is below this times the attacker's
const EPS = 1e-9;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const live = r => r.state !== 'dead' && r.state !== 'rout';
const isBattle = b => !!b && typeof b === 'object' && Array.isArray(b.regs);
// Round half away from zero: the same on both sides of the centre line.
const snap = v => (v < 0 ? -Math.round(-v * GRID) : Math.round(v * GRID)) / GRID;
// sqrt of a sum is exactly sign-symmetric and identical on every engine (Math.hypot is not specified).
const len = (dx, dy) => Math.sqrt(dx * dx + dy * dy);
const turn = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

// ---------- setup ----------

function cleanUnits(units) {
  const out = [];
  if (!Array.isArray(units)) return out;
  for (let i = 0; i < units.length && out.length < MAX_PER_SIDE; i++) {
    const u = units[i];
    if (!u || typeof u !== 'object' || typeof u.type !== 'string' || !Object.hasOwn(TYPES, u.type)) continue;
    const max = TYPES[u.type].men;
    out.push({ type: u.type, men: isNum(u.men) ? clamp(Math.floor(u.men), 1, max) : max, ui: i });
  }
  return out;
}

const rowOf = type => (type === 'archer' ? 1 : type === 'cav' ? 2 : 0);

// Infantry in front, archers behind them, cavalry in reserve; side 1 is the exact mirror of side 0.
function deploy(units, side) {
  const counts = [0, 0, 0], seen = [0, 0, 0];
  for (const u of units) counts[rowOf(u.type)]++;
  return units.map(u => {
    const row = rowOf(u.type), col = seen[row]++, count = counts[row];
    const cx = -(HW - 300 + row * 90);
    const cy = (col - (count - 1) / 2) * Math.min(90, 780 / Math.max(1, count - 1));
    return { x: snap(side === 0 ? cx : -cx) + HW, y: snap(cy) + HH };
  });
}

export function createBattle(armies, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const regs = [];
  let id = 1;
  for (const side of [0, 1]) {
    const units = Array.isArray(armies) ? cleanUnits(armies[side]) : cleanUnits(DEFAULT_ARMY.map(type => ({ type })));
    const spots = deploy(units, side);
    units.forEach((u, i) => {
      const T = TYPES[u.type];
      regs.push({
        id: id++, owner: side, type: u.type, x: spots[i].x, y: spots[i].y,
        face: side === 0 ? 0 : Math.PI, ui: u.ui,
        men: u.men, maxMen: T.men, startMen: u.men, morale: 100, ammo: T.ammo || 0,
        order: null, state: 'idle', routT: 0, charged: 0, engaged: null, near: null, stuck: 0,
      });
    });
  }
  return {
    regs, time: 0, over: false, winner: null, reason: null,
    timeLimit: isNum(o.timeLimit) && o.timeLimit > 0 ? o.timeLimit : BATTLE_TIME_LIMIT,
    defender: o.defender === 0 || o.defender === 1 ? o.defender : null,
  };
}

// ---------- orders ----------

// Returns a validated copy of the order, or null when it must be ignored.
function cleanOrder(b, owner, order) {
  if (!order || typeof order !== 'object') return null;
  if (order.t === 'stop') return { t: 'stop' };
  if (order.t === 'move') {
    if (!isNum(order.x) || !isNum(order.y)) return null;
    const o = { t: 'move', x: snap(clamp(order.x, EDGE, W - EDGE) - HW) + HW, y: snap(clamp(order.y, EDGE, H - EDGE) - HH) + HH };
    if (isNum(order.face)) o.face = Math.atan2(Math.sin(order.face), Math.cos(order.face));
    return o;
  }
  if (order.t === 'attack') {
    if (!Number.isInteger(order.target)) return null;
    const tg = b.regs.find(q => q.id === order.target);
    return tg && tg.owner !== owner && live(tg) ? { t: 'attack', target: tg.id } : null;
  }
  return null;
}

export function giveOrder(b, owner, ids, order) {
  if (!isBattle(b) || b.over || (owner !== 0 && owner !== 1) || !Array.isArray(ids)) return;
  const o = cleanOrder(b, owner, order);
  if (!o) return;
  for (const r of b.regs) {
    if (r.owner !== owner || !live(r) || !ids.includes(r.id)) continue;
    r.order = o.t === 'stop' ? null : { ...o };
    r.near = null; r.stuck = 0;                 // a new order starts a new march
  }
}

// ---------- one tick ----------

// Tick-start picture of every regiment, in centre-relative grid coordinates.
function startView(regs) {
  return regs.map(r => ({ r, T: TYPES[r.type], x: snap(r.x - HW), y: snap(r.y - HH), live: live(r), dmg: 0, shock: 0, by: -1, byDist: Infinity }));
}

// Nearest live enemy closer than `reach`; ties go to the lower index, which mirrors cleanly.
function nearestEnemy(view, i, reach) {
  const v = view[i];
  let best = -1, bd = reach;
  for (let j = 0; j < view.length; j++) {
    const q = view[j];
    if (!q.live || q.r.owner === v.r.owner) continue;
    const d = len(q.x - v.x, q.y - v.y);
    if (d < bd) { bd = d; best = j; }
  }
  return best;
}

// What regiment i wants to do this tick, decided from the tick-start view only.
function plan(view, i) {
  const v = view[i], r = v.r, T = v.T, o = r.order;
  const p = { target: -1, fight: false, shoot: false, move: false, mx: 0, my: 0, room: 0, arrive: false, drop: false, near: null, stuck: 0 };
  if (!v.live) return p;
  const shoots = T.ranged && r.ammo > 0;
  if (o && o.t === 'move') {
    const mx = snap(o.x - HW), my = snap(o.y - HH), d = len(mx - v.x, my - v.y);
    // Regiments sent to one spot cannot all stand on it: whoever stops getting closer has arrived.
    const closer = r.near === null || d < r.near - PROGRESS;
    const stuck = closer ? 0 : r.stuck + 1;
    if (d < ARRIVE || stuck >= STALL_TICKS) p.arrive = true;
    else { p.move = true; p.mx = mx; p.my = my; p.room = d; p.near = closer ? d : r.near; p.stuck = stuck; }
    return p;                                   // a marching regiment does not fight
  }
  if (o && o.t === 'attack') {
    p.target = view.findIndex(q => q.live && q.r.id === o.target && q.r.owner !== r.owner);
    if (p.target < 0) p.drop = true;            // target routed or died: back to no order
  }
  if (p.target < 0) p.target = nearestEnemy(view, i, shoots ? T.range : ACQUIRE);
  if (p.target < 0) return p;
  const q = view[p.target], d = len(q.x - v.x, q.y - v.y);
  const melee = T.ranged ? T.meleeRange : T.range;   // out of ammo, archers must close to melee range
  const reach = shoots ? T.range : melee + MELEE_SLACK;
  const hold = shoots ? T.range * SHOOT_HOLD : melee + MELEE_HOLD;
  if (d <= reach) { p.fight = true; p.shoot = shoots; }
  if (d > hold) { p.move = true; p.mx = q.x; p.my = q.y; p.room = d - hold; }
  return p;
}

// Damage regiment i deals this tick, accumulated on its target's view entry.
function strike(view, i, p) {
  const a = view[i], t = view[p.target], T = a.T, TT = t.T;
  const dx = a.x - t.x, dy = a.y - t.y;
  const off = turn(Math.atan2(dy, dx), t.r.face);   // attacker's bearing against the target's tick-start facing
  const rear = off > REAR;
  let mult = 1;
  if (T.charge && a.r.charged < CHARGE_TIME - EPS) mult *= T.charge;
  if (TT.antiCav && a.r.type === 'cav') mult /= TT.antiCav;
  if (!T.ranged) mult *= rear ? 1.8 : off > FLANK ? 1.35 : 1;
  const dps = T.ranged ? (p.shoot ? T.dps : T.meleeDps) : T.dps;
  const dmg = a.r.men * dps * mult * (1 - TT.armor) * TICK * 10;
  t.dmg += dmg;
  t.shock += dmg * (rear ? 1.4 : 0.6) * (60 / t.r.startMen) * 0.6;
  const d = len(dx, dy);
  if (d < t.byDist) { t.byDist = d; t.by = i; }
}

// Casualties, morale loss, ammo, charge timers, order bookkeeping and facing.
function applyCombat(view, plans) {
  for (let i = 0; i < view.length; i++) {
    const v = view[i], r = v.r, p = plans[i];
    if (!v.live) continue;
    const hadOrder = !!r.order;
    if (p.drop) r.order = null;
    if (p.arrive) {
      if (isNum(r.order.face)) r.face = r.order.face;
      r.order = null;
    }
    if (p.target >= 0 && (p.fight || p.move)) {
      const q = view[p.target];
      r.face = Math.atan2(q.y - v.y, q.x - v.x);
    } else if (p.move) {
      r.face = Math.atan2(p.my - v.y, p.mx - v.x);
    } else if (!hadOrder && v.by >= 0) {
      const q = view[v.by];                     // standing idle under attack: turn to the nearest attacker
      r.face = Math.atan2(q.y - v.y, q.x - v.x);
    }
    r.near = p.near; r.stuck = p.stuck;
    if (p.shoot) r.ammo = Math.max(0, r.ammo - TICK);
    if (!p.fight) r.charged = 0;
    else if (v.T.charge && r.charged < CHARGE_TIME - EPS) r.charged += TICK;
    r.engaged = p.fight ? view[p.target].r.id : null;
    r.men -= v.dmg;
    r.morale -= v.shock;
  }
}

function applyMovement(view, plans) {
  for (let i = 0; i < view.length; i++) {
    const v = view[i], r = v.r, p = plans[i];
    if (r.state === 'dead') continue;
    if (r.state === 'rout') {
      const dir = r.owner === 0 ? -1 : 1;       // run for the own table edge
      v.x += dir * v.T.speed * 1.3 * TICK;
      r.face = dir > 0 ? 0 : Math.PI;
      r.routT += TICK;
      continue;
    }
    if (p.move) {
      const dx = p.mx - v.x, dy = p.my - v.y, d = len(dx, dy) || 1;
      const s = Math.min(v.T.speed * TICK, p.room);
      v.x += (dx / d) * s; v.y += (dy / d) * s;
    }
    r.state = p.fight ? 'fighting' : p.move ? 'moving' : 'idle';
  }
}

// Push overlapping regiments apart. All pushes are measured from the post-movement positions and
// applied together; friend and enemy pushes are summed separately so the total mirrors exactly.
// A regiment marching into a friend also slides sideways (side 0 keeps left, side 1 mirrors it),
// otherwise one walking exactly behind another would shove it along at half speed for ever.
function separate(view, plans) {
  const marching = plans.map(p => p.move && !p.fight);
  const n = view.length, px = new Array(n).fill(0), py = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = view[i];
    if (!a.live) continue;
    let fx = 0, fy = 0, ex = 0, ey = 0;
    for (let j = 0; j < n; j++) {
      const c = view[j];
      if (j === i || !c.live) continue;
      const friend = c.r.owner === a.r.owner, gap = friend ? GAP_FRIEND : GAP_ENEMY;
      const dx = a.x - c.x, dy = a.y - c.y, d = len(dx, dy);
      if (d >= gap) continue;
      const k = (gap - d) / 2;
      let ux, uy;
      if (d > 0.01) { ux = dx / d; uy = dy / d; }
      else if (friend) { ux = 0; uy = i < j ? -1 : 1; }          // stacked friends split up and down
      else { ux = a.r.owner === 0 ? -1 : 1; uy = 0; }            // stacked enemies back off to their own side
      if (!friend) { ex += ux * k; ey += uy * k; continue; }
      fx += ux * k; fy += uy * k;
      if (marching[i] || marching[j]) {
        const spin = a.r.owner === 0 ? SLIDE * k : -SLIDE * k;
        fx -= uy * spin; fy += ux * spin;
      }
    }
    px[i] = fx + ex; py[i] = fy + ey;
  }
  for (let i = 0; i < n; i++) { view[i].x += px[i]; view[i].y += py[i]; }
}

// Write positions back, then morale recovery, death and rout.
function settle(view) {
  for (const v of view) {
    const r = v.r;
    if (r.state === 'dead') continue;
    if (r.state === 'rout') {
      r.x = snap(v.x) + HW;
      if (Math.abs(v.x) > HW + 40 || r.routT > ROUT_TIME) r.state = 'dead';
      continue;
    }
    r.x = snap(clamp(v.x, -HW, HW)) + HW;
    r.y = snap(clamp(v.y, -HH, HH)) + HH;
    if (v.dmg === 0) r.morale = Math.min(100, r.morale + TICK * 1.5);
    if (r.men <= 0.5) { r.state = 'dead'; r.men = 0; r.morale = 0; r.order = null; r.engaged = null; continue; }
    if (r.morale <= 0 || r.men < r.startMen * ROUT_MEN) {
      r.state = 'rout'; r.morale = Math.max(0, r.morale); r.order = null; r.engaged = null; r.routT = 0;
    }
  }
}

// Share of a side's starting strength that is still in the fight. A regiment that is routing but not
// yet gone counts for half its men (the same half it would take back to a campaign).
function strength(regs, side) {
  let now = 0, start = 0;
  for (const r of regs) {
    if (r.owner !== side) continue;
    start += r.startMen;
    if (r.state === 'rout') now += r.men / 2;
    else if (r.state !== 'dead') now += r.men;
  }
  return start > 0 ? now / start : 0;
}

// Timeout verdict. With a defender (campaign): the defender holds unless its surviving share is below
// DEFENDER_EDGE times the attacker's, so a regiment that merely runs away cannot win on the clock.
// Without one: the larger surviving share wins and a gap under DRAW_MARGIN is a draw.
function verdict(b) {
  const f = [strength(b.regs, 0), strength(b.regs, 1)];
  if (b.defender === 0 || b.defender === 1) {
    const d = b.defender;
    return f[d] < DEFENDER_EDGE * f[1 - d] ? 1 - d : d;
  }
  return Math.abs(f[0] - f[1]) < DRAW_MARGIN ? -1 : f[0] > f[1] ? 0 : 1;
}

function judge(b) {
  const alive = [0, 1].map(s => b.regs.some(r => r.owner === s && live(r)));
  if (!alive[0] || !alive[1]) {
    b.over = true; b.reason = 'rout';
    b.winner = alive[0] ? 0 : alive[1] ? 1 : -1;
    return;
  }
  if (b.time < b.timeLimit - EPS) return;
  b.over = true; b.reason = 'timeout';
  b.winner = verdict(b);
}

export function step(b) {
  if (!isBattle(b) || b.over) return;
  const view = startView(b.regs);
  const plans = view.map((_, i) => plan(view, i));
  for (let i = 0; i < view.length; i++) if (plans[i].fight) strike(view, i, plans[i]);
  applyCombat(view, plans);
  applyMovement(view, plans);
  separate(view, plans);
  settle(view);
  // Count whole ticks rather than adding 0.05 six thousand times: no drift at the time limit.
  b.time = (Math.round(b.time / TICK) + 1) * TICK;
  judge(b);
}

// ---------- views ----------

export function snapshot(b) {
  if (!isBattle(b)) return { time: 0, left: 0, regs: [] };
  return {
    time: +b.time.toFixed(1),
    left: Math.max(0, Math.ceil(b.timeLimit - b.time - EPS)),
    regs: b.regs.map(r => [r.id, r.owner, r.type, Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10,
      Math.round(r.face * 100) / 100, Math.max(0, Math.ceil(r.men)), Math.max(0, Math.round(r.morale)),
      r.state, r.ammo ? Math.round(r.ammo) : 0, r.engaged || 0]),
  };
}

// Units still on the field after a battle, for carrying back to the campaign.
// Routed units that got away keep half their men.
export function battleSurvivors(b, side) {
  if (!isBattle(b)) return [];
  return b.regs.filter(r => r.owner === side && r.state !== 'dead')
    .map(r => ({ type: r.type, men: Math.max(1, Math.ceil(r.state === 'rout' ? r.men / 2 : r.men)) }));
}
