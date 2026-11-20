// Authoritative battle simulation. Pure logic, no networking.
export const W = 1600, H = 900;
const TICK = 0.05;

export const TYPES = {
  sword:  { name: 'Shortsword Infantry', men: 60, speed: 46,  range: 16,  dps: 0.040, armor: 0.30, ranged: false },
  spear:  { name: 'Spear Phalanx',       men: 60, speed: 38,  range: 18,  dps: 0.030, armor: 0.35, ranged: false, antiCav: 2 },
  archer: { name: 'Archers',             men: 40, speed: 52,  range: 170, dps: 0.026, armor: 0.05, ranged: true, ammo: 30, meleeDps: 0.008 },
  cav:    { name: 'Heavy Cavalry',       men: 24, speed: 110, range: 18,  dps: 0.070, armor: 0.20, ranged: false, charge: 1.8 },
};

const FACTIONS = {
  0: ['sword', 'sword', 'sword', 'spear', 'spear', 'archer', 'archer', 'cav', 'cav'],
  1: ['sword', 'sword', 'spear', 'spear', 'spear', 'archer', 'archer', 'cav', 'cav'],
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function createBattle(armies) {
  const regs = [];
  let id = 1;
  for (const side of [0, 1]) {
    const units = armies ? armies[side] : FACTIONS[side].map(type => ({ type, men: TYPES[type].men }));
    const list = units.map(u => u.type);
    list.forEach((type, i) => {
      const t = TYPES[type];
      const row = type === 'archer' ? 1 : type === 'cav' ? 2 : 0;
      const col = list.filter((x, j) => j < i && (x === 'archer' ? 1 : x === 'cav' ? 2 : 0) === row).length;
      const count = list.filter(x => (x === 'archer' ? 1 : x === 'cav' ? 2 : 0) === row).length;
      const baseX = side === 0 ? 300 - row * 90 : W - 300 + row * 90;
      const y = H / 2 + (col - (count - 1) / 2) * Math.min(90, 780 / Math.max(1, count - 1));
      regs.push({
        id: id++, owner: side, type, x: baseX, y,
        face: side === 0 ? 0 : Math.PI,
        ui: i, men: units[i].men, maxMen: t.men, morale: 100, ammo: t.ammo || 0,
        order: null, state: 'idle', routT: 0, charged: 0, engaged: null,
      });
    });
  }
  return { regs, time: 0, over: false, winner: null };
}

export function giveOrder(b, owner, ids, order) {
  for (const r of b.regs) {
    if (r.owner !== owner || r.state === 'dead' || r.state === 'rout') continue;
    if (!ids.includes(r.id)) continue;
    if (order.t === 'stop') r.order = null;
    else if (order.t === 'move') r.order = { t: 'move', x: clamp(order.x, 10, W - 10), y: clamp(order.y, 10, H - 10) };
    else if (order.t === 'attack') {
      const tg = b.regs.find(q => q.id === order.target);
      if (tg && tg.owner !== owner && tg.state !== 'dead') r.order = { t: 'attack', target: tg.id };
    }
  }
}

const clamp = (v, a, bb) => Math.max(a, Math.min(bb, Number.isFinite(v) ? v : a));
const live = r => r.state !== 'dead' && r.state !== 'rout';

export function step(b) {
  if (b.over) return;
  b.time += TICK;
  const regs = b.regs;
  for (const r of regs) { r.dmgTaken = 0; r.engaged = null; }

  for (const r of regs) {
    if (r.state === 'dead') continue;
    const T = TYPES[r.type];

    if (r.state === 'rout') {
      r.routT += TICK;
      const dir = r.owner === 0 ? -1 : 1;
      r.x += dir * T.speed * 1.3 * TICK; r.face = dir > 0 ? 0 : Math.PI;
      if (r.x < -40 || r.x > W + 40 || r.routT > 20) r.state = 'dead';
      continue;
    }

    // choose target
    let target = null;
    if (r.order && r.order.t === 'attack') {
      target = regs.find(q => q.id === r.order.target && live(q));
      if (!target) r.order = null;
    }
    if (!target && (!r.order || r.order.t !== 'move')) {
      let best = Infinity;
      const reach = T.ranged ? T.range : 40;
      for (const q of regs) {
        if (q.owner === r.owner || !live(q)) continue;
        const d = dist(r, q);
        if (d < reach && d < best) { best = d; target = q; }
      }
    }

    let moveTo = null;
    if (r.order && r.order.t === 'move') {
      moveTo = r.order;
      if (Math.hypot(r.x - moveTo.x, r.y - moveTo.y) < 4) { r.order = null; moveTo = null; }
    } else if (target) {
      const d = dist(r, target);
      const hold = T.ranged && r.ammo > 0 ? T.range * 0.95 : T.range + 6;
      if (d > hold) moveTo = target;
    }

    // fight
    let fighting = false;
    if (target) {
      const d = dist(r, target);
      const inRange = T.ranged && r.ammo > 0 ? d <= T.range : d <= T.range + 12;
      if (inRange && !(r.order && r.order.t === 'move')) {
        fighting = true; r.engaged = target.id;
        r.face = Math.atan2(target.y - r.y, target.x - r.x);
        let dps = T.ranged ? (r.ammo > 0 ? T.dps : T.meleeDps) : T.dps;
        if (T.ranged && r.ammo > 0) r.ammo = Math.max(0, r.ammo - TICK);
        let mult = 1;
        const TT = TYPES[target.type];
        if (T.charge && r.charged < 1) { mult *= T.charge; r.charged += TICK; }
        if (TT.antiCav && r.type === 'cav') mult *= 1 / TT.antiCav;
        // flank/rear bonus based on target's facing
        const toAtt = Math.atan2(r.y - target.y, r.x - target.x);
        let diff = Math.abs(((toAtt - target.face + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (!T.ranged) { if (diff > 2.3) mult *= 1.8; else if (diff > 1.2) mult *= 1.35; }
        const dmg = r.men * dps * mult * (1 - TT.armor) * TICK * 10;
        target.dmgTaken += dmg * (diff > 2.3 ? 1.8 : 1);
        target.men -= dmg;
        target.morale -= dmg * (diff > 2.3 ? 1.4 : 0.6) * (60 / target.maxMen) * 0.6;
        // defender turns to face attacker if idle-ish
        if (!target.order && !target.engaged) target.face = Math.atan2(r.y - target.y, r.x - target.x);
      }
    }
    if (!fighting) r.charged = Math.min(r.charged, 0.5);
    if (r.type === 'cav' && !fighting) r.charged = 0;

    // movement
    if (moveTo && !(fighting && !(r.order && r.order.t === 'move'))) {
      const dx = moveTo.x - r.x, dy = moveTo.y - r.y, d = Math.hypot(dx, dy) || 1;
      const sp = T.speed * TICK;
      r.x += (dx / d) * Math.min(sp, d); r.y += (dy / d) * Math.min(sp, d);
      r.face = Math.atan2(dy, dx);
      r.state = 'moving';
    } else r.state = fighting ? 'fighting' : 'idle';
  }

  // separation
  for (let i = 0; i < regs.length; i++) for (let j = i + 1; j < regs.length; j++) {
    const a = regs[i], c = regs[j];
    if (!live(a) || !live(c)) continue;
    const d = dist(a, c), min = 30;
    if (d < min && d > 0.01) {
      const push = (min - d) / 2, nx = (a.x - c.x) / d, ny = (a.y - c.y) / d;
      a.x += nx * push; a.y += ny * push; c.x -= nx * push; c.y -= ny * push;
    }
  }

  // morale, death, rout
  for (const r of regs) {
    if (!live(r)) continue;
    r.x = clamp(r.x, 0, W); r.y = clamp(r.y, 0, H);
    if (r.dmgTaken === 0) r.morale = Math.min(100, r.morale + TICK * 1.5);
    // nearby friendly strength steadies morale
    if (r.men <= 0.5) { r.state = 'dead'; r.men = 0; continue; }
    if (r.morale <= 0 || r.men < r.maxMen * 0.15) { r.state = 'rout'; r.order = null; }
  }

  // victory
  const alive = [0, 1].map(s => regs.some(r => r.owner === s && live(r)));
  if (!alive[0] || !alive[1]) { b.over = true; b.winner = alive[0] ? 0 : alive[1] ? 1 : -1; }
}

export function snapshot(b) {
  return {
    time: +b.time.toFixed(1),
    regs: b.regs.map(r => [r.id, r.owner, r.type, Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10,
      Math.round(r.face * 100) / 100, Math.ceil(r.men), Math.round(r.morale), r.state, r.ammo ? Math.round(r.ammo) : 0, r.engaged || 0]),
  };
}

// Units still on the field after a battle, for carrying back to the campaign.
// Routed units that got away keep half their men.
export function battleSurvivors(b, side) {
  return b.regs.filter(r => r.owner === side && r.state !== 'dead')
    .map(r => ({ type: r.type, men: Math.max(1, Math.ceil(r.state === 'rout' ? r.men / 2 : r.men)) }));
}

export { TICK };
