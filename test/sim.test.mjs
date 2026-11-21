// Battle simulation: validation, fairness (simultaneous resolution), determinism, rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  W, H, TICK, TYPES, BATTLE_TIME_LIMIT, createBattle, giveOrder, step, snapshot, battleSurvivors,
} from '../sim.js';

// ---------- helpers ----------

// Seeded PRNG (mulberry32): the tests are random-looking but repeat exactly.
function prng(seed) {
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
const NAMES = Object.keys(TYPES);
const full = (type, n = 1) => Array.from({ length: n }, () => ({ type, men: TYPES[type].men }));
const isLive = r => r.state !== 'dead' && r.state !== 'rout';
const side = (b, s) => b.regs.filter(r => r.owner === s);
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angleGap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function randomArmy(rnd, max = 20) {
  return Array.from({ length: 1 + Math.floor(rnd() * max) }, () => {
    const type = pick(rnd, NAMES);
    return { type, men: 1 + Math.floor(rnd() * TYPES[type].men) };
  });
}

function place(r, x, y, face) {
  r.x = x; r.y = y;
  if (face !== undefined) r.face = face;
  return r;
}

// A duel on an empty field: one regiment per side, placed by the test.
function duel(type0, type1, opts) {
  const b = createBattle([[{ type: type0, men: TYPES[type0].men }], [{ type: type1, men: TYPES[type1].men }]], opts);
  return { b, a: b.regs[0], c: b.regs[1] };
}

function run(b, onTick, maxTicks = 20000) {
  let n = 0;
  while (!b.over && n++ < maxTicks) { step(b); if (onTick) onTick(b); }
  return b;
}

// A random order for regiments `mine` against `theirs`, as plain data.
function randomOrder(rnd, mine, theirs) {
  const k = rnd();
  const ids = mine.filter(() => rnd() < 0.4).map(r => r.id);
  if (k < 0.1) return { ids, order: { t: 'stop' } };
  if (k < 0.55) {
    const order = { t: 'move', x: rnd() * W, y: rnd() * H };
    if (rnd() < 0.5) order.face = (rnd() * 2 - 1) * Math.PI;
    return { ids, order };
  }
  return { ids, order: { t: 'attack', target: pick(rnd, theirs).id } };
}

// The same order seen from the other side of the table.
function mirrorOrder(o, mapId) {
  const order = { ...o.order };
  if (order.t === 'move') {
    order.x = W - order.x;
    if (order.face !== undefined) order.face = Math.PI - order.face;
  }
  if (order.t === 'attack') order.target = mapId(order.target);
  return { ids: o.ids.map(mapId), order };
}

// Largest deviation between regiment list `left` and the mirror image of `right`.
function mirrorError(left, right) {
  let worst = 0;
  assert.equal(left.length, right.length);
  left.forEach((a, i) => {
    const c = right[i];
    assert.equal(a.type, c.type);
    assert.equal(a.state, c.state, `state of unit ${i}`);
    worst = Math.max(worst, Math.abs(a.x + c.x - W), Math.abs(a.y - c.y), Math.abs(a.men - c.men),
      Math.abs(a.morale - c.morale), Math.abs(a.ammo - c.ammo), angleGap(a.face, Math.PI - c.face));
  });
  return worst;
}

function assertSane(b, label) {
  for (const r of b.regs) {
    for (const k of ['x', 'y', 'face', 'men', 'morale', 'ammo']) {
      assert.ok(Number.isFinite(r[k]), `${label}: ${k} of #${r.id} is ${r[k]}`);
    }
    assert.ok(r.men >= 0 && r.men <= r.startMen, `${label}: men ${r.men}`);
    assert.ok(r.morale >= 0 && r.morale <= 100, `${label}: morale ${r.morale}`);
    assert.ok(r.ammo >= 0, `${label}: ammo ${r.ammo}`);
    assert.ok(['idle', 'moving', 'fighting', 'rout', 'dead'].includes(r.state), `${label}: state ${r.state}`);
    if (isLive(r)) {
      assert.ok(r.x >= 0 && r.x <= W && r.y >= 0 && r.y <= H, `${label}: #${r.id} left the field at ${r.x},${r.y}`);
    } else {
      // Routing regiments run off the table edge and are removed just beyond it.
      assert.ok(r.x >= -50 && r.x <= W + 50 && r.y >= 0 && r.y <= H, `${label}: router at ${r.x},${r.y}`);
    }
  }
}

// ---------- module surface ----------

test('exports and unit types', () => {
  assert.equal(BATTLE_TIME_LIMIT, 300);
  assert.equal(TICK, 0.05);
  assert.equal(W, 1600);
  assert.equal(H, 900);
  assert.deepEqual(Object.keys(TYPES), ['sword', 'spear', 'archer', 'cav']);
  for (const t of Object.values(TYPES)) assert.ok(Number.isInteger(t.men) && t.men > 0, 'campaign.js needs men on every type');
  assert.equal(TYPES.archer.meleeRange, 16);
  assert.ok(TYPES.archer.range > 100, 'shooting range is unchanged');
  assert.doesNotThrow(() => JSON.stringify(TYPES));
});

test('default armies are identical and mirrored', () => {
  const b = createBattle();
  assert.deepEqual({ time: b.time, over: b.over, winner: b.winner, reason: b.reason, timeLimit: b.timeLimit, defender: b.defender },
    { time: 0, over: false, winner: null, reason: null, timeLimit: BATTLE_TIME_LIMIT, defender: null });
  const s0 = side(b, 0), s1 = side(b, 1);
  assert.deepEqual(s0.map(r => r.type), ['sword', 'sword', 'sword', 'spear', 'spear', 'archer', 'archer', 'cav', 'cav']);
  assert.deepEqual(s1.map(r => r.type), s0.map(r => r.type));
  assert.equal(mirrorError(s0, s1), 0);
  assert.deepEqual(b.regs.map(r => r.id), Array.from({ length: 18 }, (_, i) => i + 1));
  for (const r of b.regs) {
    assert.equal(r.men, TYPES[r.type].men);
    assert.equal(r.startMen, r.men);
    assert.equal(r.maxMen, TYPES[r.type].men);
    assert.equal(r.morale, 100);
    assert.equal(r.state, 'idle');
    assert.equal(r.order, null);
    assert.equal(r.face, r.owner === 0 ? 0 : Math.PI);
  }
  assert.ok(s0.every(r => r.x < W / 2) && s1.every(r => r.x > W / 2));
});

test('createBattle validates units', () => {
  const junk = [
    { type: 'sword', men: 30 }, { type: 'constructor', men: 10 }, { type: '__proto__', men: 10 },
    { type: 'toString', men: 5 }, { type: 'hasOwnProperty' }, { type: 7, men: 5 }, { men: 5 }, null, 'sword', 42, [],
    { type: 'archer', men: 0 }, { type: 'archer', men: -5 }, { type: 'cav', men: 1e9 }, { type: 'spear', men: 12.7 },
    { type: 'spear', men: NaN }, { type: 'spear', men: '30' }, { type: 'sword' }, { type: 'cav', men: Infinity },
  ];
  const b = createBattle([junk, []]);
  assert.deepEqual(side(b, 0).map(r => [r.type, r.men]), [
    ['sword', 30], ['archer', 1], ['archer', 1], ['cav', 24], ['spear', 12],
    ['spear', 60], ['spear', 60], ['sword', 60], ['cav', 24],
  ]);
  for (const r of b.regs) {
    assert.ok(Number.isInteger(r.men) && r.men >= 1 && r.men <= TYPES[r.type].men);
    assert.equal(r.startMen, r.men);
    assert.equal(r.maxMen, TYPES[r.type].men);
  }
  assert.equal(side(b, 1).length, 0);
});

test('createBattle keeps at most 20 units per side, inside the field and apart', () => {
  const b = createBattle([full('sword', 45), [...full('archer', 30), ...full('cav', 3)]]);
  assert.equal(side(b, 0).length, 20);
  assert.equal(side(b, 1).length, 20);
  assert.ok(side(b, 1).every(r => r.type === 'archer'));
  assertSane(b, 'deploy');
  for (const a of b.regs) for (const c of b.regs) if (a.id < c.id) assert.ok(gap(a, c) >= 30, 'no overlap at deployment');
  assert.equal(new Set(b.regs.map(r => r.id)).size, 40);
});

test('createBattle options', () => {
  assert.equal(createBattle(undefined, { timeLimit: 42 }).timeLimit, 42);
  for (const timeLimit of [0, -5, NaN, Infinity, '60', null, {}]) {
    assert.equal(createBattle(undefined, { timeLimit }).timeLimit, BATTLE_TIME_LIMIT);
  }
  assert.equal(createBattle(undefined, { defender: 0 }).defender, 0);
  assert.equal(createBattle(undefined, { defender: 1 }).defender, 1);
  for (const defender of [2, -1, '0', null, undefined, NaN, true]) {
    assert.equal(createBattle(undefined, { defender }).defender, null);
  }
});

// ---------- bad input ----------

test('bad input never throws', () => {
  const armiesList = [null, undefined, 'x', 5, {}, [], [null, null], [5, 'a'], [[null, 1, 'a', {}], [{ type: 'sword', men: {} }]],
    [[{ type: 'sword', men: 1e308 }]], [{ length: 3 }, { 0: { type: 'sword' } }]];
  for (const armies of armiesList) {
    for (const opts of [undefined, null, 'x', 7, [], { timeLimit: 'x', defender: {} }]) {
      const b = createBattle(armies, opts);
      assert.ok(Array.isArray(b.regs));
      for (let i = 0; i < 5; i++) step(b);
      snapshot(b);
      battleSurvivors(b, 0);
    }
  }
  for (const bad of [null, undefined, 0, 'x', {}, [], { regs: 5 }]) {
    assert.doesNotThrow(() => step(bad));
    assert.doesNotThrow(() => giveOrder(bad, 0, [1], { t: 'stop' }));
    assert.deepEqual(snapshot(bad), { time: 0, left: 0, regs: [] });
    assert.deepEqual(battleSurvivors(bad, 0), []);
  }
  const b = createBattle();
  const before = JSON.stringify(b);
  const orders = [null, undefined, 5, 'move', [], {}, { t: 'fly' }, { t: 'constructor' }, { t: 'move' }, { t: 'move', x: 'a', y: 5 },
    { t: 'move', x: NaN, y: 5 }, { t: 'move', x: 5, y: Infinity }, { t: 'move', x: '100', y: '100' }, { t: 'move', x: null, y: null },
    { t: 'attack' }, { t: 'attack', target: 'x' }, { t: 'attack', target: 10.5 }, { t: 'attack', target: NaN },
    { t: 'attack', target: 999 }, { t: 'attack', target: [10] }, { t: ['move'], x: 1, y: 1 }];
  for (const order of orders) {
    for (const ids of [[1, 2, 3], null, undefined, 'abc', 5, {}, [NaN, 'x', null, {}], [10, 11]]) {
      for (const owner of [0, 1, 2, -1, '0', null, undefined, NaN]) {
        assert.doesNotThrow(() => giveOrder(b, owner, ids, order));
      }
    }
  }
  assert.equal(JSON.stringify(b), before, 'no invalid order changed the battle');
  assert.equal(battleSurvivors(b, 7).length, 0);
});

test('giveOrder only moves the caller\'s live regiments', () => {
  const b = createBattle();
  const [a1, a2, a3] = side(b, 0), [e1] = side(b, 1);
  giveOrder(b, 0, [a1.id, e1.id, 999], { t: 'move', x: 500, y: 400 });
  assert.deepEqual(a1.order, { t: 'move', x: 500, y: 400 });
  assert.equal(e1.order, null, 'cannot order the other side');
  assert.equal(a2.order, null, 'ids not listed are untouched');
  giveOrder(b, 1, [a1.id], { t: 'stop' });
  assert.ok(a1.order, 'the enemy cannot stop my regiment');

  a2.state = 'rout'; a3.state = 'dead';
  giveOrder(b, 0, [a2.id, a3.id], { t: 'move', x: 500, y: 400 });
  assert.equal(a2.order, null);
  assert.equal(a3.order, null);

  giveOrder(b, 0, [a1.id], { t: 'attack', target: a2.id });
  assert.equal(a1.order.t, 'move', 'cannot attack an own regiment');
  e1.state = 'rout';
  giveOrder(b, 0, [a1.id], { t: 'attack', target: e1.id });
  assert.equal(a1.order.t, 'move', 'cannot attack a routing regiment');
  e1.state = 'idle';
  giveOrder(b, 0, [a1.id], { t: 'attack', target: e1.id, x: 5, junk: 1 });
  assert.deepEqual(a1.order, { t: 'attack', target: e1.id });
  giveOrder(b, 0, [a1.id], { t: 'stop' });
  assert.equal(a1.order, null);
});

test('giveOrder clamps destinations, keeps only a finite facing, and copies the order', () => {
  const b = createBattle();
  const [a1, a2] = side(b, 0);
  giveOrder(b, 0, [a1.id], { t: 'move', x: -1e9, y: 1e300 });
  assert.deepEqual(a1.order, { t: 'move', x: 10, y: H - 10 });
  for (const face of [NaN, Infinity, '1', null, {}, undefined]) {
    giveOrder(b, 0, [a1.id], { t: 'move', x: 400, y: 400, face });
    assert.ok(!('face' in a1.order), `face ${String(face)} must be ignored`);
  }
  giveOrder(b, 0, [a1.id], { t: 'move', x: 400, y: 400, face: 1.25 });
  assert.ok(near(a1.order.face, 1.25));
  giveOrder(b, 0, [a1.id], { t: 'move', x: 400, y: 400, face: 1.25 + 200 * Math.PI });
  assert.ok(near(a1.order.face, 1.25, 1e-9), 'facing is normalised');

  const mine = { t: 'move', x: 600, y: 300, face: 0.5 };
  giveOrder(b, 0, [a1.id, a2.id], mine);
  mine.x = NaN;
  assert.equal(a1.order.x, 600);
  assert.notEqual(a1.order, a2.order, 'each regiment has its own order object');
});

test('orders are ignored once the battle is over', () => {
  const b = createBattle(undefined, { timeLimit: TICK });
  step(b);
  assert.equal(b.over, true);
  giveOrder(b, 0, [1], { t: 'move', x: 500, y: 500 });
  assert.equal(b.regs[0].order, null);
});

// ---------- determinism and fairness ----------

test('determinism: the same inputs give identical snapshots', () => {
  for (const seed of [1, 2, 3]) {
    const play = () => {
      const rnd = prng(seed);
      const b = createBattle([randomArmy(rnd), randomArmy(rnd)]);
      const frames = [];
      run(b, () => {
        for (const s of [0, 1]) {
          if (rnd() < 0.05) {
            const o = randomOrder(rnd, side(b, s), side(b, 1 - s));
            giveOrder(b, s, o.ids, o.order);
          }
        }
        frames.push(JSON.stringify(snapshot(b)));
      });
      return { frames, end: JSON.stringify(b) };
    };
    const one = play(), two = play();
    assert.ok(one.frames.length > 10);
    assert.deepEqual(one.frames, two.frames);
    assert.equal(one.end, two.end);
  }
});

test('mirror symmetry: identical armies with mirrored orders stay mirrored and draw', () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const rnd = prng(seed);
    const army = seed === 11 ? undefined : randomArmy(rnd);
    const b = createBattle(army && [army, army]);
    const n = b.regs.length / 2;
    const other = id => (id <= n ? id + n : id - n);
    let worst = mirrorError(side(b, 0), side(b, 1)), fights = 0;
    run(b, () => {
      // Most orders are attacks so the armies really meet; the rest are marches and stops.
      if (rnd() < 0.08) {
        const o = rnd() < 0.6
          ? { ids: side(b, 0).filter(() => rnd() < 0.5).map(r => r.id), order: { t: 'attack', target: pick(rnd, side(b, 1)).id } }
          : randomOrder(rnd, side(b, 0), side(b, 1));
        giveOrder(b, 0, o.ids, o.order);
        const m = mirrorOrder(o, other);
        giveOrder(b, 1, m.ids, m.order);
      }
      worst = Math.max(worst, mirrorError(side(b, 0), side(b, 1)));
      if (b.regs.some(r => r.state === 'fighting')) fights++;
    });
    assert.ok(worst <= 1e-6, `seed ${seed}: mirror error ${worst}`);
    assert.ok(fights > 0, `seed ${seed}: the armies must actually fight`);
    assert.equal(b.over, true);
    assert.equal(b.winner, -1, `seed ${seed}: a mirrored battle is a draw`);
    assert.deepEqual(battleSurvivors(b, 0), battleSurvivors(b, 1));
  }
});

test('swapping sides gives the mirrored result: no advantage from array position', () => {
  let decisive = 0;
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const rnd = prng(seed);
    const armyA = randomArmy(rnd, 12), armyB = randomArmy(rnd, 12);
    const one = createBattle([armyA, armyB]), two = createBattle([armyB, armyA]);
    const nA = side(one, 0).length, nB = side(one, 1).length;
    // Regiment k of army A is id k in `one` and id nB + k in `two`; army B the other way round.
    const swap = id => (id <= nA ? id + nB : id - nA);
    let worst = 0;
    while (!one.over) {
      for (const s of [0, 1]) {
        if (rnd() < 0.06) {
          const o = rnd() < 0.7
            ? { ids: side(one, s).filter(() => rnd() < 0.6).map(r => r.id), order: { t: 'attack', target: pick(rnd, side(one, 1 - s)).id } }
            : randomOrder(rnd, side(one, s), side(one, 1 - s));
          giveOrder(one, s, o.ids, o.order);
          const m = mirrorOrder(o, swap);
          giveOrder(two, 1 - s, m.ids, m.order);
        }
      }
      step(one); step(two);
      worst = Math.max(worst, mirrorError(side(one, 0), side(two, 1)), mirrorError(side(one, 1), side(two, 0)));
    }
    assert.ok(worst <= 1e-6, `seed ${seed}: mirror error ${worst}`);
    assert.equal(two.over, true);
    assert.equal(two.time, one.time);
    assert.equal(two.reason, one.reason);
    assert.equal(two.winner, one.winner === -1 ? -1 : 1 - one.winner, `seed ${seed}`);
    assert.deepEqual(battleSurvivors(two, 1), battleSurvivors(one, 0));
    assert.deepEqual(battleSurvivors(two, 0), battleSurvivors(one, 1));
    if (one.winner !== -1) decisive++;
  }
  assert.ok(decisive >= 3, 'the sample must contain decisive battles');
});

test('an even duel is resolved simultaneously: equal losses every tick, then a draw', () => {
  for (const type of NAMES) {
    const { b, a, c } = duel(type, type);
    place(a, 700, 450); place(c, 900, 450);
    giveOrder(b, 0, [a.id], { t: 'attack', target: c.id });
    giveOrder(b, 1, [c.id], { t: 'attack', target: a.id });
    let hurt = 0;
    run(b, () => {
      assert.equal(a.men, c.men, `${type}: both sides lose men in step`);
      assert.equal(a.morale, c.morale);
      assert.equal(a.state, c.state);
      if (a.men < a.startMen) hurt++;
    });
    assert.ok(hurt > 0);
    assert.equal(b.winner, -1);
    assert.equal(b.reason, 'rout');
    assert.ok(b.time < 120, `${type} duel took ${b.time}s`);
  }
});

test('regiments in melee stay in contact instead of being pushed out of reach', () => {
  const { b, a, c } = duel('sword', 'spear');
  place(a, 700, 450); place(c, 800, 450);
  giveOrder(b, 0, [a.id], { t: 'attack', target: c.id });
  let started = false, ticksFighting = 0, breaks = 0;
  run(b, () => {
    if (!isLive(a) || !isLive(c)) return;
    const both = a.state === 'fighting' && c.state === 'fighting';
    if (both) { started = true; ticksFighting++; } else if (started) breaks++;
  });
  assert.ok(ticksFighting > 20, 'they fight for more than a second');
  assert.equal(breaks, 0, 'once joined, the melee is continuous');
  assert.equal(b.reason, 'rout');
});

// ---------- long-run safety ----------

test('fuzz: random and hostile orders never produce NaN, negative men or off-field regiments', () => {
  const garbage = [
    { t: 'move', x: NaN, y: 1 }, { t: 'move', x: 1e308, y: -1e308 }, { t: 'move', x: -0, y: 0, face: 1e308 },
    { t: 'attack', target: 0 }, { t: 'attack', target: -1 }, { t: 'attack', target: 2 ** 31 }, { t: 'nope' }, null,
    { t: 'move', x: 800, y: 450, face: -1e9 }, { t: 'move', x: 5e-324, y: 899.9999999 },
  ];
  let timeouts = 0, routs = 0;
  for (let seed = 100; seed < 160; seed++) {
    const rnd = prng(seed);
    const timeLimit = seed % 3 === 0 ? BATTLE_TIME_LIMIT : 20 + Math.floor(rnd() * 100);
    const b = createBattle(seed % 5 === 0 ? undefined : [randomArmy(rnd), randomArmy(rnd)], { timeLimit });
    const all = b.regs.map(r => r.id);
    let ticks = 0;
    while (!b.over) {
      for (const s of [0, 1]) {
        const roll = rnd();
        if (roll < 0.10) {
          const o = randomOrder(rnd, side(b, s), side(b, 1 - s));
          giveOrder(b, s, o.ids, o.order);
        } else if (roll < 0.13) {
          giveOrder(b, s, all, pick(rnd, garbage));            // every id, including the enemy's
        } else if (roll < 0.15) {
          giveOrder(b, s, all, { t: 'attack', target: pick(rnd, all) });
        }
      }
      step(b);
      ticks++;
      assertSane(b, `seed ${seed} t=${b.time}`);
      const snap = snapshot(b);
      assert.ok(snap.left >= 0 && Number.isInteger(snap.left));
      assert.ok(ticks <= Math.round(timeLimit / TICK), `seed ${seed}: still running after the time limit`);
    }
    assert.ok(b.time <= timeLimit + 1e-9);
    assert.ok([0, 1, -1].includes(b.winner));
    assert.ok(['rout', 'timeout'].includes(b.reason));
    const wire = JSON.stringify(snapshot(b));
    assert.ok(!wire.includes('null'), 'snapshots contain no NaN');
    for (const s of [0, 1]) for (const u of battleSurvivors(b, s)) {
      assert.ok(Number.isInteger(u.men) && u.men >= 1 && u.men <= TYPES[u.type].men);
    }
    if (b.reason === 'timeout') timeouts++; else routs++;
  }
  assert.ok(timeouts > 0 && routs > 0, `both endings are exercised (${routs} routs, ${timeouts} timeouts)`);
});

test('stacked regiments are pushed apart without NaN', () => {
  const b = createBattle([full('sword', 4), full('spear', 2)]);
  for (const r of b.regs) place(r, 800, 450);
  for (let i = 0; i < 200; i++) step(b);
  assertSane(b, 'stack');
  const mine = side(b, 0).filter(isLive);
  for (const a of mine) for (const c of mine) if (a.id < c.id) assert.ok(gap(a, c) > 29, `friends ${a.id},${c.id} still overlap`);

  // Regiments sent to the same spot spread out around it.
  const m = createBattle([full('sword', 3), full('sword', 1)]);
  giveOrder(m, 0, side(m, 0).map(r => r.id), { t: 'move', x: 500, y: 450 });
  for (let i = 0; i < 400; i++) step(m);
  const [p, q, r] = side(m, 0);
  assert.ok(gap(p, q) > 25 && gap(q, r) > 25 && gap(p, r) > 25);
  assertSane(m, 'same spot');
});

test('regiments sent to one point all arrive: the march ends when they stop getting closer', () => {
  for (const n of [2, 3, 9, 20]) {
    const b = createBattle([full('sword', n), full('sword', 1)]);
    const mine = side(b, 0);
    giveOrder(b, 0, mine.map(r => r.id), { t: 'move', x: 600, y: 450, face: 1 });
    for (let i = 0; i < 1000; i++) step(b);
    for (const r of mine) {
      assert.equal(r.order, null, `${n} regiments: #${r.id} is still marching`);
      assert.equal(r.state, 'idle');
      assert.ok(near(r.face, 1), 'and takes the ordered facing');
      assert.ok(gap(r, { x: 600, y: 450 }) < 45 + 17 * Math.sqrt(n), 'close to the spot');
    }
    assert.ok(mine.some(r => gap(r, { x: 600, y: 450 }) < 30));
  }
  // A lone regiment with a clear road still walks all the way.
  const b = createBattle([full('spear', 1), full('sword', 1)]);
  giveOrder(b, 0, [1], { t: 'move', x: 1333.3, y: 77.7 });
  for (let i = 0; i < 1000; i++) step(b);
  assert.ok(gap(b.regs[0], { x: 1333.3, y: 77.7 }) < 4);
  assert.equal(b.regs[0].order, null);
});

test('a regiment marching straight into a friend slides past instead of shoving it along', () => {
  for (const owner of [0, 1]) {
    const b = createBattle([[...full('cav', 1), ...full('spear', 1)], [...full('cav', 1), ...full('spear', 1)]]);
    const [cav, spear] = side(b, owner);
    const dir = owner === 0 ? 1 : -1;
    place(cav, 800 - dir * 300, 450); place(spear, 800 - dir * 200, 450);       // exactly in the way
    giveOrder(b, owner, [cav.id], { t: 'move', x: 800 + dir * 300, y: 450 });
    const x0 = spear.x;
    for (let i = 0; i < 115; i++) step(b);                    // 600 units at 110 per second is 5.5 s
    assert.equal(cav.order, null, 'arrived on time');
    assert.ok(gap(cav, { x: 800 + dir * 300, y: 450 }) < 4);
    assert.ok(Math.abs(spear.x - x0) < 40 && Math.abs(spear.y - 450) < 40, 'the friend was only nudged aside');
  }
});

// ---------- time limit ----------

test('every battle ends by the time limit; a passive battle times out as a draw', () => {
  const b = createBattle();
  assert.equal(snapshot(b).left, 300);
  step(b);
  assert.equal(snapshot(b).left, 300);
  for (let i = 1; i < 20; i++) step(b);
  assert.equal(b.time, 1);
  assert.equal(snapshot(b).left, 299);
  let ticks = 20;
  while (!b.over) { step(b); ticks++; assert.ok(ticks <= 6000); }
  assert.equal(ticks, 6000, 'exactly 300 s of ticks');
  assert.equal(b.time, 300);
  assert.equal(b.reason, 'timeout');
  assert.equal(b.winner, -1);
  assert.equal(snapshot(b).left, 0);
  assert.equal(snapshot(b).time, 300);

  const frozen = JSON.stringify(b);
  step(b); step(b);
  assert.equal(JSON.stringify(b), frozen, 'step is a no-op once the battle is over');
});

test('custom time limits count sim seconds', () => {
  const b = createBattle(undefined, { timeLimit: 1 });
  assert.equal(snapshot(b).left, 1);
  for (let i = 0; i < 19; i++) step(b);
  assert.equal(b.over, false);
  assert.equal(snapshot(b).left, 1);
  step(b);
  assert.equal(b.over, true);
  assert.equal(b.reason, 'timeout');
  assert.equal(snapshot(b).left, 0);

  const odd = createBattle(undefined, { timeLimit: 0.72 });
  run(odd);
  assert.ok(near(odd.time, 0.75), 'ends on the first tick at or past the limit');
});

test('timeout winner with a defender: it holds unless its surviving share is below 0.75 of the attackers share', () => {
  // Shares are live men / start men per side (3 swords of 60 each); only the defender is damaged here.
  const timed = (defender, share, prepare = () => {}) => {
    const b = createBattle([full('sword', 3), full('sword', 3)], { timeLimit: 0.5, defender });
    for (const r of side(b, defender)) r.men = r.startMen * share;
    prepare(side(b, defender), side(b, 1 - defender));
    return run(b);
  };
  for (const defender of [0, 1]) {
    const attacker = 1 - defender;
    let b = timed(defender, 1);
    assert.deepEqual([b.reason, b.winner], ['timeout', defender], 'equal shares: the defender holds');
    assert.equal(timed(defender, 0.76).winner, defender, '0.76 of the attackers 1.0: holds');
    assert.equal(timed(defender, 0.74).winner, attacker, '0.74: the attacker wins');
    assert.equal(timed(defender, 0.5).winner, attacker, 'clearly weaker: the attacker wins');
    // a damaged attacker lowers the bar: 0.5 of 0.6 is 0.83
    b = timed(defender, 0.5, (d, a) => { for (const r of a) r.men = r.startMen * 0.6; });
    assert.equal(b.winner, defender);
    // routing regiments count at half weight on both sides: (60 + 60 + 30) / 180 = 0.83 against a 1.0 attacker
    b = timed(defender, 1, d => { d[2].state = 'rout'; });
    assert.equal(b.winner, defender, 'one routing regiment of three is only half a loss');
    b = timed(defender, 1, d => { d[1].state = 'rout'; d[2].state = 'rout'; });   // (60 + 30 + 30) / 180 = 0.67
    assert.equal(b.winner, attacker);
    b = timed(defender, 1, (d, a) => { d[1].state = 'rout'; d[2].state = 'rout'; a[2].state = 'rout'; });   // 0.67 against 0.83
    assert.equal(b.winner, defender, '0.67 is not below 0.75 * 0.83 = 0.625');
    b = timed(defender, 0.6, (d, a) => { a[2].state = 'rout'; });   // 0.6 against 0.83
    assert.equal(b.winner, attacker, '0.6 is below 0.625');
    b = timed(defender, 1, (d, a) => { d[2].state = 'rout'; a[1].state = 'rout'; a[2].state = 'rout'; });   // 0.83 against 0.67
    assert.equal(b.winner, defender);
  }
});

test('timeout winner without a defender: larger surviving share, or a draw within 2%', () => {
  const timed = prepare => {
    const b = createBattle([full('sword', 2), full('sword', 4)], { timeLimit: 0.5 });
    prepare(side(b, 0), side(b, 1));
    return run(b);
  };
  let b = timed(() => {});
  assert.deepEqual([b.winner, b.reason], [-1, 'timeout'], 'different sizes, same share: draw');

  b = timed(s0 => { s0[0].men = 54; });                       // 114/120 = 0.95 vs 1.0
  assert.equal(b.winner, 1);
  b = timed((s0, s1) => { s1[0].men = 40; });                 // 1.0 vs 220/240 = 0.917
  assert.equal(b.winner, 0);
  b = timed(s0 => { s0[0].men = 58; });                       // 0.983 vs 1.0: inside the margin
  assert.equal(b.winner, -1);
  b = timed((s0, s1) => { s0[0].men = 57; s1[0].men = 55; }); // 0.975 vs 0.979
  assert.equal(b.winner, -1);

  // Routing regiments count at half weight: one of four routing is 0.875, not 1.0 and not 0.75.
  b = timed((s0, s1) => { s0[0].men = 36; s1[0].state = 'rout'; });   // 0.8 vs 0.875
  assert.equal(b.winner, 1);
  b = timed((s0, s1) => { s0[0].men = 54; s1[0].state = 'rout'; });   // 0.95 vs 0.875
  assert.equal(b.winner, 0);
  b = timed((s0, s1) => { s1[0].state = 'rout'; s1[1].state = 'rout'; });   // 1.0 vs 0.75
  assert.equal(b.winner, 0);

  // Shares are measured against the strength at the start of the battle, not full strength.
  const d = createBattle([[{ type: 'sword', men: 10 }], [{ type: 'sword', men: 60 }]], { timeLimit: 0.5 });
  run(d);
  assert.equal(d.winner, -1);
});

test('a rout ends the battle with reason "rout"; mutual destruction is a draw', () => {
  const { b, a, c } = duel('cav', 'archer');
  place(a, 700, 450); place(c, 760, 450);
  giveOrder(b, 0, [a.id], { t: 'attack', target: c.id });
  run(b);
  assert.deepEqual([b.winner, b.reason], [0, 'rout']);
  assert.ok(b.time < 30);

  const empty = createBattle([[], full('sword', 1)]);
  step(empty);
  assert.deepEqual([empty.over, empty.winner, empty.reason], [true, 1, 'rout']);
  const none = createBattle([[], []]);
  step(none);
  assert.deepEqual([none.over, none.winner, none.reason], [true, -1, 'rout']);
});

// ---------- rules ----------

test('rout threshold uses the strength at battle start: depleted units fight on', () => {
  // 5 of 60 men is under 15% of full strength; v1 routed such a unit on the first tick.
  const b = createBattle([[{ type: 'sword', men: 5 }, { type: 'archer', men: 3 }, { type: 'cav', men: 2 }], [{ type: 'spear', men: 8 }]]);
  for (let i = 0; i < 40; i++) step(b);
  for (const r of b.regs) {
    assert.equal(r.state, 'idle', `${r.type} with ${r.startMen} men`);
    assert.equal(r.men, r.startMen);
  }
  assert.equal(b.over, false);

  // It breaks below 15% of what it brought to this battle.
  const { b: d, a, c } = duel('sword', 'sword');
  a.men = a.startMen = 20;
  place(a, 780, 450); place(c, 805, 450, Math.PI);
  let seen = false;
  run(d, () => {
    if (a.state === 'rout' && !seen) {
      seen = true;
      assert.ok(a.men < 3 || a.morale === 0, `routed with ${a.men} men, morale ${a.morale}`);
    }
    if (isLive(a)) assert.ok(a.men >= 3 - 1e-9 || a.men <= 0.5);
  });
  assert.equal(d.winner, 1);
});

test('morale loss is normalised by the starting strength', () => {
  const lossAfterOneTick = startMen => {
    const { b, a, c } = duel('sword', 'sword');
    c.men = c.startMen = startMen;
    place(a, 780, 450, 0); place(c, 805, 450, Math.PI);
    step(b);
    return { men: startMen - c.men, morale: 100 - c.morale };
  };
  const big = lossAfterOneTick(60), small = lossAfterOneTick(30);
  const dmg = 60 * 0.040 * (1 - 0.30) * TICK * 10;            // front attack by 60 swordsmen
  assert.ok(near(big.men, dmg) && near(small.men, dmg));
  assert.ok(near(big.morale, dmg * 0.6 * (60 / 60) * 0.6));
  assert.ok(near(small.morale, dmg * 0.6 * (60 / 30) * 0.6), 'the same casualties hurt a half-size unit twice as much');
});

test('morale recovers at 1.5 per second for a regiment that took no damage, up to 100', () => {
  const { b, a } = duel('sword', 'sword');
  place(a, 200, 450); place(b.regs[1], 1400, 450);
  a.morale = 50;
  for (let i = 0; i < 40; i++) step(b);                       // 2 s, nobody anywhere near
  assert.ok(near(a.morale, 50 + 2 * 1.5, 1e-6), `morale ${a.morale}`);
  a.morale = 99.95;
  step(b);
  assert.equal(a.morale, 100);
  a.morale = 50;
  const foe = b.regs[1];
  place(foe, a.x + 15, a.y);                                   // in contact: it takes damage, so no recovery
  step(b);
  assert.ok(a.morale < 50);
});

test('damage formula: front, flank, rear, charge and spear wall', () => {
  const firstHit = (attacker, target, targetFace) => {
    const { b, a, c } = duel(attacker, target);
    place(a, 780, 450, 0); place(c, 805, 450, targetFace);
    giveOrder(b, 1, [c.id], { t: 'move', x: 1500, y: 450 });   // marching: it does not fight back
    step(b);
    return { men: c.startMen - c.men, morale: 100 - c.morale, a, c, b };
  };
  const base = 60 * 0.040 * (1 - 0.30) * TICK * 10;
  const front = firstHit('sword', 'sword', Math.PI);
  assert.ok(near(front.men, base));
  const flank = firstHit('sword', 'sword', Math.PI / 2);
  assert.ok(near(flank.men, base * 1.35));
  assert.ok(near(flank.morale, base * 1.35 * 0.6 * 0.6));
  const rear = firstHit('sword', 'sword', 0);
  assert.ok(near(rear.men, base * 1.8));
  assert.ok(near(rear.morale, base * 1.8 * 1.4 * 0.6), 'rear attacks break morale');

  const charge = firstHit('cav', 'sword', Math.PI);
  assert.ok(near(charge.men, 24 * 0.070 * 1.8 * (1 - 0.30) * TICK * 10));
  const wall = firstHit('cav', 'spear', Math.PI);
  assert.ok(near(wall.men, 24 * 0.070 * 1.8 / 2 * (1 - 0.35) * TICK * 10), 'spears halve cavalry damage');

  // Archers get no flank bonus on damage, and shooting uses ammo.
  const shot = firstHit('archer', 'sword', 0);
  assert.ok(near(shot.men, 40 * 0.026 * (1 - 0.30) * TICK * 10));
  assert.ok(near(shot.a.ammo, 30 - TICK));
});

test('the cavalry charge bonus lasts one second of continuous melee', () => {
  const { b, a, c } = duel('cav', 'spear');
  c.men = c.startMen = 60;
  place(a, 780, 450, 0); place(c, 800, 450, Math.PI);
  giveOrder(b, 0, [a.id], { t: 'attack', target: c.id });
  const perTick = [];
  for (let i = 0; i < 30; i++) {
    const before = c.men, attackers = a.men;
    step(b);
    perTick.push((before - c.men) / attackers);
  }
  const plain = 0.070 / 2 * (1 - 0.35) * TICK * 10;
  for (let i = 0; i < 20; i++) assert.ok(near(perTick[i], plain * 1.8), `tick ${i} is a charge`);
  for (let i = 20; i < 30; i++) assert.ok(near(perTick[i], plain), `tick ${i} is ordinary melee`);
});

test('archers without ammo cannot hurt anything beyond melee range', () => {
  // Idle and out of ammo, 100 away: v1 dealt melee damage from here because it reused the shooting range.
  const idle = duel('archer', 'sword');
  idle.a.ammo = 0;
  place(idle.a, 700, 450, 0); place(idle.c, 800, 450, Math.PI);
  for (let i = 0; i < 100; i++) step(idle.b);
  assert.equal(idle.c.men, 60);
  assert.equal(idle.a.x, 700, 'it does not wander off after distant enemies either');

  // Ordered to attack, it must walk into contact first.
  const { b, a, c } = duel('archer', 'sword');
  a.ammo = 0;
  place(a, 620, 450, 0); place(c, 800, 450, Math.PI);
  giveOrder(b, 1, [c.id], { t: 'move', x: 801, y: 450 });      // keeps the sword from attacking back at once
  giveOrder(b, 0, [a.id], { t: 'attack', target: c.id });
  let firstHitAt = null;
  for (let i = 0; i < 200 && firstHitAt === null; i++) {
    const before = c.men, d = gap(a, c);
    step(b);
    if (c.men < before) firstHitAt = d;
    else assert.ok(c.men === 60);
  }
  assert.ok(firstHitAt !== null, 'it does fight once in contact');
  assert.ok(firstHitAt <= TYPES.archer.meleeRange + 12 + 1e-9, `first melee hit landed from ${firstHitAt}`);

  // With arrows left, the same archers hit from far away, and weakly in melee once they run dry.
  const shooting = duel('archer', 'sword');
  place(shooting.a, 640, 450, 0); place(shooting.c, 800, 450, Math.PI);
  step(shooting.b);
  assert.ok(shooting.c.men < 60);
  const dry = duel('archer', 'sword');
  dry.a.ammo = 0;
  place(dry.a, 780, 450, 0); place(dry.c, 800, 450, Math.PI);
  giveOrder(dry.b, 1, [dry.c.id], { t: 'move', x: 1500, y: 450 });
  step(dry.b);
  assert.ok(near(60 - dry.c.men, 40 * 0.008 * (1 - 0.30) * TICK * 10));
});

test('archers run out of arrows after 30 s of shooting', () => {
  const { b, a, c } = duel('archer', 'spear');
  place(a, 300, 450, 0); place(c, 460, 450, Math.PI);
  giveOrder(b, 1, [c.id], { t: 'move', x: 461, y: 450 });
  c.men = c.startMen = 60;
  let shots = 0;
  for (let i = 0; i < 700; i++) {
    const before = a.ammo;
    c.men = 60; c.morale = 100;                               // an unbreakable target
    step(b);
    if (a.ammo < before) shots++;
  }
  assert.ok(shots >= 600 && shots <= 601, `${shots} ticks of shooting`);
  assert.equal(a.ammo, 0);
  assert.equal(snapshot(b).regs[0][9], 0);
});

test('facing on arrival', () => {
  const b = createBattle();
  const [a1, a2, a3] = side(b, 0);
  const y1 = a1.y;
  giveOrder(b, 0, [a1.id], { t: 'move', x: 420, y: y1, face: Math.PI / 2 });
  giveOrder(b, 0, [a2.id], { t: 'move', x: 420, y: a2.y });
  giveOrder(b, 0, [a3.id], { t: 'move', x: a3.x, y: a3.y + 100, face: -3 });
  for (let i = 0; i < 100; i++) step(b);
  assert.equal(a1.order, null);
  assert.equal(a1.state, 'idle');
  assert.ok(near(a1.face, Math.PI / 2), 'takes the ordered facing');
  assert.ok(gap(a1, { x: 420, y: y1 }) < 4);
  assert.ok(near(a2.face, 0), 'without a facing it keeps its direction of march');
  assert.ok(near(a3.face, -3));
  assert.equal(snapshot(b).regs[0][5], 1.57);
});

test('an idle regiment under fire turns to its nearest attacker; the first volley uses its old facing', () => {
  const b = createBattle([full('sword', 1), full('archer', 2)]);
  const [s] = side(b, 0), [far, nearby] = side(b, 1);
  place(s, 800, 450, Math.PI);                                // looking the wrong way
  place(far, 800, 300, 0); place(nearby, 800, 570, 0);
  step(b);
  const volley = 40 * 0.026 * (1 - 0.30) * TICK * 10;
  // Tick-start facing was west: both archers shoot it in the flank, not the rear, so morale takes x0.6.
  assert.ok(near(100 - s.morale, 2 * volley * 0.6 * 0.6));
  assert.ok(near(s.face, Math.PI / 2), 'faces the nearer archers (below it)');
  assert.equal(s.state, 'idle');

  // A regiment with an order keeps its facing while it is shot at.
  const m = createBattle([full('sword', 1), full('archer', 1)]);
  const [t] = side(m, 0), [arch] = side(m, 1);
  place(t, 800, 450, 0); place(arch, 800, 570, 0);
  giveOrder(m, 0, [t.id], { t: 'move', x: 200, y: 450 });
  step(m);
  assert.ok(near(t.face, Math.PI));

  // Rear shots hurt morale more: target facing away at tick start.
  const r = createBattle([full('sword', 1), full('archer', 1)]);
  const [u] = side(r, 0), [sh] = side(r, 1);
  place(u, 800, 450, Math.PI); place(sh, 900, 450, Math.PI);
  step(r);
  assert.ok(near(100 - u.morale, volley * 1.4 * 0.6));
  assert.ok(near(u.face, 0), 'and then it turns round');
});

test('idle melee troops pick up enemies within 40; marching troops ignore them', () => {
  const { b, a, c } = duel('sword', 'spear');
  place(a, 700, 450); place(c, 745, 450);
  for (let i = 0; i < 20; i++) step(b);
  assert.equal(a.state, 'idle', '45 away: not acquired');
  assert.equal(c.men, 60);
  place(c, 739, 450);
  for (let i = 0; i < 40; i++) step(b);
  assert.ok(c.men < 60 && a.men < 60, 'inside 40 both sides join battle');

  const m = duel('sword', 'spear');
  place(m.a, 700, 450); place(m.c, 730, 470);
  giveOrder(m.b, 0, [m.a.id], { t: 'move', x: 1200, y: 450 });
  step(m.b);
  assert.equal(m.a.state, 'moving');
  assert.equal(m.c.men, 60, 'a marching regiment does not strike');
});

test('an attack order chases its target and is dropped when the target breaks', () => {
  const b = createBattle([full('cav', 1), [...full('archer', 1), ...full('spear', 1)]]);
  const [cav] = side(b, 0), [arch, spear] = side(b, 1);
  place(spear, 1500, 100);
  arch.ammo = 0;                                              // a full quiver would shoot the lone cavalry down
  giveOrder(b, 0, [cav.id], { t: 'attack', target: arch.id });
  giveOrder(b, 1, [arch.id], { t: 'move', x: 1500, y: 800 });
  let sawRout = false;
  for (let i = 0; i < 2000 && !b.over && !sawRout; i++) {
    step(b);
    if (!isLive(arch)) sawRout = true;
  }
  assert.ok(sawRout, 'cavalry catches and breaks the archers');
  step(b);
  assert.equal(cav.order, null);
  assert.equal(arch.order, null);
  assert.equal(arch.engaged, null);
});

test('routing regiments flee to their own edge and are gone within 20 s', () => {
  for (const owner of [0, 1]) {
    const b = createBattle([full('sword', 2), full('sword', 2)]);
    const r = side(b, owner)[0];
    place(r, 800, 450);
    r.men = 8;                                                // under 15% of the 60 it started with
    step(b);
    assert.equal(r.state, 'rout');
    assert.equal(r.order, null);
    const x0 = r.x;
    for (let i = 0; i < 20; i++) step(b);
    assert.ok(owner === 0 ? r.x < x0 - 50 : r.x > x0 + 50, 'runs toward its own side');
    assert.deepEqual(battleSurvivors(b, owner).map(u => u.men), [4, 60], 'a router keeps half its men');
    for (let i = 0; i < 400; i++) step(b);
    assert.equal(r.state, 'dead');
    assert.equal(battleSurvivors(b, owner).length, 1, 'once gone it is lost');
    assertSane(b, 'rout');
  }
});

// ---------- views ----------

test('snapshot layout is unchanged and adds only "left"', () => {
  const b = createBattle();
  giveOrder(b, 0, [8], { t: 'attack', target: 15 });
  let engaged = 0;
  for (let i = 0; i < 300; i++) { step(b); engaged += snapshot(b).regs.filter(row => row[10] !== 0).length; }
  const s = snapshot(b);
  assert.deepEqual(Object.keys(s), ['time', 'left', 'regs']);
  assert.equal(s.time, 15);
  assert.equal(s.left, 285);
  assert.equal(s.regs.length, 18);
  for (const row of s.regs) {
    assert.equal(row.length, 11);
    const [id, owner, type, x, y, face, men, morale, state, ammo, engagedId] = row;
    assert.ok(Number.isInteger(id) && (owner === 0 || owner === 1) && Object.hasOwn(TYPES, type));
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(face));
    assert.ok(Number.isInteger(men) && men >= 0);
    assert.ok(Number.isInteger(morale) && morale >= 0 && morale <= 100);
    assert.equal(typeof state, 'string');
    assert.ok(Number.isInteger(ammo) && ammo >= 0);
    assert.ok(Number.isInteger(engagedId) && engagedId >= 0);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.ok(engaged > 0, 'engagedId is reported while regiments fight');
  const first = b.regs[0];
  assert.deepEqual(s.regs[0].slice(0, 5), [first.id, first.owner, first.type, Math.round(first.x * 10) / 10, Math.round(first.y * 10) / 10]);
});

test('battleSurvivors: whole men, at least 1, routers keep half, the dead are left out', () => {
  const b = createBattle([full('sword', 4), full('archer', 1)]);
  const [a1, a2, a3, a4] = side(b, 0);
  a1.men = 41.2;
  a2.men = 41.2; a2.state = 'rout';
  a3.men = 0.7; a3.state = 'rout';
  a4.state = 'dead';
  assert.deepEqual(battleSurvivors(b, 0), [{ type: 'sword', men: 42 }, { type: 'sword', men: 21 }, { type: 'sword', men: 1 }]);
  assert.deepEqual(battleSurvivors(b, 1), [{ type: 'archer', men: 40 }]);
});
