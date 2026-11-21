// Battle AI: finishes battles, beats a passive opponent, deterministic, plays by the rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { W, H, TICK, TYPES, BATTLE_TIME_LIMIT, createBattle, giveOrder, step, snapshot, battleSurvivors } from '../sim.js';
import { botThink } from '../bot.js';

// ---------- helpers ----------

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
const NAMES = Object.keys(TYPES);
const full = (type, n = 1) => Array.from({ length: n }, () => ({ type, men: TYPES[type].men }));
const isLive = r => r.state !== 'dead' && r.state !== 'rout';
const side = (b, s) => b.regs.filter(r => r.owner === s);
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const liveMen = (b, s) => side(b, s).filter(isLive).reduce((n, r) => n + r.men, 0);

// Campaign-style army: 1 to 20 units, any mix, some badly depleted.
function randomArmy(rnd) {
  return Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => {
    const type = NAMES[Math.floor(rnd() * NAMES.length)];
    const men = rnd() < 0.3 ? 1 + Math.floor(rnd() * 6) : 1 + Math.floor(rnd() * TYPES[type].men);
    return { type, men };
  });
}

// Plays a battle to the end; `bots` lists the sides driven by the AI. The server calls botThink
// after every step, so the tests do the same.
function play(armies, bots, opts, onTick) {
  const b = createBattle(armies, opts);
  let guard = 0;
  while (!b.over) {
    step(b);
    for (const s of bots) botThink(b, s);
    if (onTick) onTick(b);
    assert.ok(++guard <= BATTLE_TIME_LIMIT / TICK, 'battle did not end by the time limit');
  }
  return b;
}

function place(r, x, y, face) {
  r.x = x; r.y = y;
  if (face !== undefined) r.face = face;
  return r;
}

const CAMPAIGN_START = [{ type: 'sword', men: 60 }, { type: 'sword', men: 60 }, { type: 'spear', men: 60 }, { type: 'archer', men: 40 }];

// ---------- finishing battles ----------

test('bot vs bot with the default armies ends by rout long before the time limit', () => {
  let worst = 0;
  const n = 9;
  const b = play(undefined, [0, 1], undefined, bt => {
    for (let i = 0; i < n; i++) {
      const a = bt.regs[i], c = bt.regs[i + n];
      worst = Math.max(worst, Math.abs(a.x + c.x - W), Math.abs(a.y - c.y), Math.abs(a.men - c.men), Math.abs(a.morale - c.morale));
      assert.equal(a.state, c.state);
    }
  });
  assert.equal(b.reason, 'rout');
  assert.ok(b.time < 90, `took ${b.time}s`);
  // Same army, same AI, fair simulation: nobody can win this one.
  assert.equal(b.winner, -1);
  assert.ok(worst <= 1e-6, `two bots stay mirror images of each other (error ${worst})`);
});

test('bot vs bot battles of any composition always finish before the time limit', () => {
  const rnd = prng(2024);
  let longest = 0, decisive = 0;
  for (let k = 0; k < 250; k++) {
    const armies = [randomArmy(rnd), randomArmy(rnd)];
    const b = play(armies, [0, 1]);
    const label = `battle ${k}: ${JSON.stringify(armies)}`;
    assert.equal(b.reason, 'rout', label);
    assert.ok(b.time < BATTLE_TIME_LIMIT - 60, `${label} took ${b.time}s`);
    assert.ok([0, 1, -1].includes(b.winner));
    for (const r of b.regs) {
      assert.ok([r.x, r.y, r.face, r.men, r.morale, r.ammo].every(Number.isFinite), label);
      assert.ok(r.men >= 0 && r.men <= r.startMen, label);
    }
    for (const s of [0, 1]) for (const u of battleSurvivors(b, s)) assert.ok(Number.isInteger(u.men) && u.men >= 1);
    longest = Math.max(longest, b.time);
    if (b.winner !== -1) decisive++;
  }
  assert.ok(decisive > 200, `${decisive} of 250 uneven battles had a winner`);
  assert.ok(longest < 180, `longest battle ${longest}s`);
});

test('awkward matchups do not stall: kiting archers, cavalry only, single survivors', () => {
  const one = (type, men) => [{ type, men }];
  const cases = [
    [full('archer', 1), full('sword', 1)], [full('archer', 1), full('spear', 1)], [full('archer', 3), full('spear', 3)],
    [full('archer', 20), full('sword', 20)], [full('archer', 20), full('archer', 20)], [full('archer', 1), full('archer', 1)],
    [full('cav', 20), full('cav', 20)], [full('cav', 20), full('spear', 20)], [full('cav', 1), full('archer', 1)],
    [full('cav', 3), full('cav', 1)], [one('archer', 1), full('spear', 1)], [one('sword', 1), one('sword', 1)],
    [one('archer', 1), one('archer', 1)], [one('archer', 5), one('sword', 2)], [one('cav', 1), one('cav', 1)],
    [one('spear', 1), full('cav', 20)], [CAMPAIGN_START, CAMPAIGN_START], [full('spear', 20), full('spear', 20)],
  ];
  for (const [a0, a1] of cases) {
    for (const armies of [[a0, a1], [a1, a0]]) {
      const b = play(armies, [0, 1]);
      assert.equal(b.reason, 'rout', JSON.stringify(armies));
      assert.ok(b.time < 150, `${JSON.stringify(armies)} took ${b.time}s`);
    }
  }
});

// ---------- strength ----------

test('the bot beats a passive opponent from either side', () => {
  const lists = [undefined, [CAMPAIGN_START, CAMPAIGN_START],
    [[...full('sword', 4), ...full('cav', 2)], [...full('sword', 4), ...full('cav', 2)]],
    [[...full('spear', 2), ...full('archer', 2), ...full('cav', 1)], [...full('spear', 2), ...full('archer', 2), ...full('cav', 1)]],
    [[...full('archer', 4), ...full('sword', 2)], [...full('archer', 4), ...full('sword', 2)]]];
  for (const armies of lists) {
    for (const bot of [0, 1]) {
      const b = play(armies, [bot]);
      const label = `${JSON.stringify(armies || 'default')} bot=${bot}`;
      assert.equal(b.winner, bot, label);
      assert.equal(b.reason, 'rout', label);
      assert.ok(b.time < 150, `${label} took ${b.time}s`);
      assert.ok(liveMen(b, bot) > 0);
      assert.ok(side(b, 1 - bot).every(r => r.order === null), 'the passive side never received an order');
    }
  }
});

test('the bot beats an opponent that only ever attacks the nearest enemy', () => {
  // The v1 practice AI: once a second, idle regiments attack whatever is nearest.
  const naive = (b, s) => {
    if (Math.round(b.time / TICK) % 20) return;
    const foes = side(b, 1 - s).filter(isLive);
    for (const r of side(b, s).filter(isLive)) {
      if (r.order || !foes.length) continue;
      const target = foes.reduce((best, f) => (gap(r, f) < gap(r, best) ? f : best));
      giveOrder(b, s, [r.id], { t: 'attack', target: target.id });
    }
  };
  for (const bot of [0, 1]) {
    const b = play(undefined, [bot], undefined, bt => naive(bt, 1 - bot));
    assert.equal(b.winner, bot);
    assert.ok(b.time < 120);
  }
});

test('identical melee lines trade blow for blow: the bot cannot lose to a passive side, only draw', () => {
  // With one troop type on both sides every duel is even, and the simulation is simultaneous.
  for (const bot of [0, 1]) {
    const b = play([full('sword', 6), full('sword', 6)], [bot]);
    assert.equal(b.reason, 'rout');
    assert.ok(b.winner === bot || b.winner === -1);
    assert.ok(b.time < 60);
  }
});

// ---------- determinism and isolation ----------

test('determinism: the same battle plays out identically', () => {
  const record = seed => {
    const rnd = prng(seed);
    const frames = [];
    const b = play([randomArmy(rnd), randomArmy(rnd)], [0, 1], undefined, bt => frames.push(JSON.stringify(snapshot(bt))));
    return { frames, end: JSON.stringify(b) };
  };
  for (const seed of [5, 6, 7]) {
    const one = record(seed), two = record(seed);
    assert.ok(one.frames.length > 20);
    assert.deepEqual(one.frames, two.frames);
    assert.equal(one.end, two.end);
  }
});

test('bot state is kept per battle and per side', () => {
  const rnd = prng(99);
  const armiesA = [randomArmy(rnd), randomArmy(rnd)], armiesB = [randomArmy(rnd), randomArmy(rnd)];
  const alone = [play(armiesA, [0, 1]), play(armiesB, [0, 1])].map(b => JSON.stringify(b));
  // The same two battles interleaved tick by tick must not influence each other.
  const a = createBattle(armiesA), b = createBattle(armiesB);
  while (!a.over || !b.over) {
    for (const bt of [a, b]) {
      if (bt.over) continue;
      step(bt); botThink(bt, 0); botThink(bt, 1);
    }
  }
  assert.equal(JSON.stringify(a), alone[0]);
  assert.equal(JSON.stringify(b), alone[1]);
});

test('the bot acts every 0.5 s and only through orders to its own live regiments', () => {
  const rnd = prng(31);
  for (let k = 0; k < 20; k++) {
    const b = createBattle(k === 0 ? undefined : [randomArmy(rnd), randomArmy(rnd)]);
    const bot = k % 2;
    const thinkTicks = new Set();
    let tick = 0;
    while (!b.over) {
      step(b);
      tick++;
      // near / stuck are the march bookkeeping that giveOrder resets with every new order.
      const rest = r => JSON.stringify({ ...r, order: null, near: null, stuck: 0 });
      const frozen = b.regs.map(rest);
      const orders = b.regs.map(r => JSON.stringify(r.order));
      botThink(b, bot);
      b.regs.forEach((r, i) => {
        assert.equal(rest(r), frozen[i], 'the bot changes nothing but orders');
        const now = JSON.stringify(r.order);
        if (now === orders[i]) return;
        thinkTicks.add(tick);
        assert.equal(r.owner, bot, 'only its own regiments get orders');
        assert.ok(isLive(r), 'never orders a routing or dead regiment');
        if (r.order.t === 'attack') {
          const target = b.regs.find(q => q.id === r.order.target);
          assert.ok(target && target.owner !== bot && isLive(target), 'never targets a routing or dead regiment');
        } else {
          assert.equal(r.order.t, 'move');
          assert.ok(r.order.x >= 10 && r.order.x <= W - 10 && r.order.y >= 10 && r.order.y <= H - 10);
        }
      });
      assert.ok(tick <= 6000);
    }
    assert.ok(thinkTicks.has(1), 'it acts on the first tick');
    for (const t of thinkTicks) assert.equal(t % 10, 1, `acted at tick ${t}: not on the 0.5 s beat`);
  }
});

// ---------- behaviour ----------

// One bot decision for side 0 in a prepared position.
function decide(armies, prepare, bot = 0) {
  const b = createBattle(armies);
  prepare(side(b, 0), side(b, 1), b);
  botThink(b, bot);
  return b;
}

test('infantry attacks the nearest enemy; spears prefer cavalry within 220', () => {
  const armies = [[...full('sword', 1), ...full('spear', 1)], [...full('sword', 1), ...full('cav', 1)]];
  let b = decide(armies, ([sw, sp], [esw, ecav]) => {
    place(sw, 400, 400); place(sp, 400, 500); place(esw, 500, 450); place(ecav, 590, 500);
  });
  assert.deepEqual(side(b, 0).map(r => r.order), [{ t: 'attack', target: 3 }, { t: 'attack', target: 4 }]);
  b = decide(armies, ([sw, sp], [esw, ecav]) => {
    place(sw, 400, 400); place(sp, 400, 500); place(esw, 500, 450); place(ecav, 700, 500);
  });
  assert.deepEqual(side(b, 0).map(r => r.order), [{ t: 'attack', target: 3 }, { t: 'attack', target: 3 }], 'cavalry 300 away is ignored');
});

test('archers shoot the weakest enemy in range and close in when nothing is', () => {
  const armies = [full('archer', 1), full('sword', 3)];
  let b = decide(armies, ([ar], [e1, e2, e3]) => {
    place(ar, 400, 450); place(e1, 500, 450); place(e2, 540, 450); place(e3, 650, 450);
    e2.men = 20; e3.men = 5;                                  // e3 is weakest but out of range
  });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 3 });
  b = decide(armies, ([ar], [e1, e2, e3]) => {
    place(ar, 400, 450); place(e1, 900, 450); place(e2, 800, 450); place(e3, 1000, 450);
  });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 3 }, 'nearest when none is in range');
});

test('archers step away from melee troops closer than 70, unless cornered or out of arrows', () => {
  const armies = [full('archer', 1), full('sword', 1)];
  let b = decide(armies, ([ar], [sw]) => { place(ar, 800, 450); place(sw, 860, 450); });
  assert.deepEqual(b.regs[0].order, { t: 'move', x: 690, y: 450 }, 'about 110 straight away');

  b = decide(armies, ([ar], [sw]) => { place(ar, 800, 450); place(sw, 880, 450); });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 2 }, '80 away: keep shooting');

  b = decide(armies, ([ar], [sw]) => { place(ar, 30, 450); place(sw, 90, 450); });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 2 }, 'cornered against the edge: shoot');

  b = decide(armies, ([ar], [sw]) => { place(ar, 1575, 880); place(sw, 1540, 850); }, 0);
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 2 }, 'cornered in the far corner');

  b = decide(armies, ([ar], [sw]) => { place(ar, 60, 450); place(sw, 60, 400); });
  assert.equal(b.regs[0].order.t, 'move');
  assert.ok(b.regs[0].order.y > 500 && b.regs[0].order.x >= 20, 'slides along the edge, stays inside the field');

  b = decide(armies, ([ar], [sw]) => { place(ar, 800, 450); place(sw, 860, 450); ar.ammo = 0; });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 2 }, 'no arrows: fights like infantry');

  // Enemy archers that can still shoot are no reason to give ground.
  b = decide([full('archer', 1), full('archer', 1)], ([ar], [foe]) => { place(ar, 800, 450); place(foe, 850, 450); });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 2 });

  // A retreat in progress is finished before the next decision.
  b = decide(armies, ([ar], [sw]) => { place(ar, 800, 450); place(sw, 860, 450); });
  const order = b.regs[0].order;
  for (let i = 0; i < 15; i++) { step(b); botThink(b, 0); }
  assert.equal(b.regs[0].order, order);
});

test('cavalry waits for the lines to meet, then prefers archers, then engaged enemies, then non-spears', () => {
  const armies = [[...full('cav', 1), ...full('sword', 1)], [...full('spear', 1), ...full('sword', 1), ...full('archer', 1)]];
  const far = ([cav, sw], [esp, esw, ear]) => {
    place(cav, 200, 450); place(sw, 300, 450); place(esp, 1200, 300); place(esw, 1200, 450); place(ear, 1300, 600);
  };
  let b = decide(armies, far);
  assert.equal(b.regs[0].order, null, 'held in reserve while nothing is happening');
  assert.deepEqual(b.regs[1].order, { t: 'attack', target: 4 }, 'the infantry advances meanwhile');

  b = decide(armies, (mine, foes) => { far(mine, foes); place(mine[1], 600, 300); });
  assert.deepEqual(b.regs[0].order, { t: 'move', x: 510, y: 450, face: 0 }, 'the reserve follows 90 behind its infantry, in its own row');
  b = decide([armies[1], armies[0]], (foes, mine) => { far(mine, foes); for (const r of [...mine, ...foes]) r.x = W - r.x; place(mine[1], 1000, 300); }, 1);
  assert.deepEqual(b.regs[3].order, { t: 'move', x: 1090, y: 450, face: Math.PI }, 'mirrored for side 1');

  b = decide(armies, (mine, foes) => { far(mine, foes); foes[1].state = 'fighting'; foes[1].engaged = 2; });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 5 }, 'battle joined: archers first');

  b = decide(armies, (mine, foes) => { far(mine, foes); place(foes[0], 400, 450); });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 5 }, 'an enemy close by releases it too');

  const noArchers = [armies[0], [...full('spear', 1), ...full('sword', 2)]];
  b = decide(noArchers, ([cav, sw], [esp, e1, e2]) => {
    place(cav, 200, 450); place(sw, 700, 450); place(esp, 300, 450); place(e1, 500, 450); place(e2, 730, 450);
    e2.state = 'fighting'; e2.engaged = sw.id;
  });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 5 }, 'flank the enemy that is busy with someone else');

  b = decide(noArchers, ([cav, sw], [esp, e1, e2]) => {
    place(cav, 200, 450); place(sw, 100, 100); place(esp, 300, 450); place(e1, 500, 450); place(e2, 900, 450);
  });
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 4 }, 'nearest non-spear rather than the nearer spears');

  b = decide([full('cav', 1), full('spear', 2)], () => {});
  assert.deepEqual(b.regs[0].order, { t: 'attack', target: 2 }, 'cavalry alone does not wait, and takes spears if nothing else is left');
});

test('cavalry keeps its target for 3 s unless the target is gone', () => {
  const b = createBattle([full('cav', 1), [...full('sword', 2)]]);
  const [cav] = side(b, 0), [e1, e2] = side(b, 1);
  place(cav, 200, 450); place(e1, 1500, 300); place(e2, 1500, 600);
  step(b); botThink(b, 0);
  assert.deepEqual(cav.order, { t: 'attack', target: e1.id });
  place(e2, cav.x + 300, cav.y);                              // a much nearer target appears
  for (let i = 0; i < 50; i++) { step(b); botThink(b, 0); }
  assert.equal(cav.order.target, e1.id, 'still committed after 2.5 s');
  for (let i = 0; i < 20; i++) { step(b); botThink(b, 0); }
  assert.equal(cav.order.target, e2.id, 're-targets on the 3 s mark');
  e2.state = 'rout';
  for (let i = 0; i < 11; i++) { step(b); botThink(b, 0); }
  assert.equal(cav.order.target, e1.id, 'target gone: picks a new one at the next beat');
});

test('a held-back cavalry reserve is always released: a battle against a passive side still ends', () => {
  // Bot archers have no arrows and the enemy never moves: nothing fights until the bot closes in.
  const b = createBattle([[...full('cav', 2), ...full('sword', 1)], full('sword', 2)]);
  let guard = 0;
  while (!b.over && guard++ < 6000) { step(b); botThink(b, 0); }
  assert.deepEqual([b.winner, b.reason], [0, 'rout']);

  // Even if its infantry never manages to engage, the reserve goes in after 25 s.
  const far = createBattle([[...full('cav', 1), ...full('spear', 1)], full('archer', 1)]);
  const [cav, spear] = side(far, 0), [arch] = side(far, 1);
  arch.ammo = 0;
  place(cav, 100, 100); place(spear, 100, 800); place(arch, 1500, 100);
  giveOrder(far, 1, [arch.id], { t: 'stop' });
  for (let i = 0; i < 480; i++) { step(far); botThink(far, 0); spear.x = 100; spear.y = 800; }
  assert.ok(!cav.order || cav.order.t === 'move', 'still in reserve after 24 s');
  for (let i = 0; i < 40; i++) { step(far); botThink(far, 0); spear.x = 100; spear.y = 800; }
  assert.deepEqual(cav.order, { t: 'attack', target: arch.id });
});

// ---------- robustness ----------

test('botThink never throws on bad input and ignores a finished battle', () => {
  const b = createBattle();
  for (const battle of [undefined, null, 0, 'x', {}, [], { regs: null }, { regs: [null, 5, 'x', {}, { type: 'dragon' }], time: 0 },
    { regs: [{ type: 'sword', owner: 0, state: 'idle' }, { type: 'sword', owner: 1, state: 'idle' }], time: NaN }]) {
    for (const s of [0, 1, 2, -1, '0', null, undefined, NaN, {}]) assert.doesNotThrow(() => botThink(battle, s));
  }
  const before = JSON.stringify(b);
  for (const s of [2, -1, '0', '1', null, undefined, NaN, 0.5, true]) botThink(b, s);
  assert.equal(JSON.stringify(b), before, 'an invalid side gives no orders');

  // Corrupted regiments must not break it either.
  const odd = createBattle();
  odd.regs[3].x = NaN; odd.regs[12].type = 'dragon'; odd.regs.push(null);
  assert.doesNotThrow(() => { botThink(odd, 0); botThink(odd, 1); });

  const done = play([full('sword', 1), []], [0, 1]);
  const frozen = JSON.stringify(done);
  botThink(done, 0); botThink(done, 1);
  assert.equal(JSON.stringify(done), frozen);
});

test('works with empty and one-sided armies', () => {
  for (const armies of [[[], []], [full('cav', 1), []], [[], full('archer', 2)]]) {
    const b = play(armies, [0, 1]);
    assert.equal(b.over, true);
    assert.equal(b.reason, 'rout');
  }
});
