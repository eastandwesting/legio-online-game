#!/usr/bin/env node
// Balance measurement for Legio Online. Dependency-free; not part of `npm test`.
//
// Every figure comes from real battles: the real sim.js stepped with the real bot.js on both seats,
// both seatings of every pairing, small random position jitter so that identical armies do not replay
// one identical battle. Work is spread over worker threads; results depend on --seed only, not on
// the thread count.
//
//   node tools/balance.mjs <command> [--seed N] [--battles N] [--workers N] [--root DIR] [--jitter PX]
//
//   share     T1  win rate by unit share of the army, random armies of equal gold
//   tourney   T2/T3  round robin of all compositions within 5% of 1050 gold, and the default army
//                    against the compositions of similar cost
//   matrix    T7  pairwise matrix of single-type armies at equal gold (several budgets)
//   fair      T4  side fairness and battle length (identical armies, random jitter)
//   bot       T5  the bot against passive play, a naive rush and a hand-written plan
//   campaign  T6  AI against AI campaigns, battles fought by the real simulation
//   all       everything above with default sizes
//
//   --root DIR  take sim.js, bot.js and campaign.js from DIR instead of the repository root (used to
//               try out a candidate set of numbers without touching the repository)
//   --battles   battles per measurement (share, fair, bot: default 20000; tourney: rounds of the round robin)
//   --rounds    tourney only: repeats of every pairing, each with fresh jitter (default 1)
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const ROOT = (() => {
  const given = isMainThread ? process.argv.indexOf('--root') : -1;
  if (isMainThread) return pathToFileURL(path.resolve(given > 0 ? process.argv[given + 1] : path.join(path.dirname(SELF), '..')) + path.sep);
  return new URL(workerData.root);
})();
const sim = await import(new URL('sim.js', ROOT));
const botMod = await import(new URL('bot.js', ROOT));
const camp = await import(new URL('campaign.js', ROOT));
const { TYPES, createBattle, step, giveOrder, battleSurvivors, W, H, TICK } = sim;
const { botThink } = botMod;
const COST = camp.COST;
const KINDS = ['sword', 'spear', 'archer', 'cav'];
const MAX_UNITS = camp.MAX_UNITS;

// ---------- small helpers ----------
function prng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mix = (a, b) => { let h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x7F4A7C15, 0x85EBCA6B)) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; return h >>> 0; };
const army = counts => { const o = []; counts.forEach((n, i) => { for (let j = 0; j < n; j++) o.push({ type: KINDS[i], men: TYPES[KINDS[i]].men }); }); return o; };
const costOf = counts => counts.reduce((s, n, i) => s + n * COST[KINDS[i]], 0);
const live = r => r.state !== 'dead' && r.state !== 'rout';
const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
const tickOf = b => Math.round(b.time / TICK);
const nearestOf = (r, list) => list.reduce((best, f) => (!best || dist(r, f) < dist(r, best) ? f : best), null);

// Run one battle to its end. ctl = [fn0, fn1] called once per tick after step(); null means passive.
function play(armies, { rng, jitter = 6, ctl = [botThink, botThink], defender = null } = {}) {
  const b = createBattle(armies, { defender });
  if (jitter && rng) {
    for (const r of b.regs) {
      r.x = Math.min(W - 20, Math.max(20, r.x + (rng() * 2 - 1) * jitter));
      r.y = Math.min(H - 20, Math.max(20, r.y + (rng() * 2 - 1) * jitter));
    }
  }
  for (let n = 0; !b.over && n < 8000; n++) {
    step(b);
    if (ctl[0]) ctl[0](b, 0);
    if (ctl[1]) ctl[1](b, 1);
  }
  return b;
}
// Score of army A (1 win, .5 draw, 0 loss) against B, both seatings. Returns [scoreA, battles].
function duel(A, B, opts) {
  let s = 0, t = 0, to = 0;
  for (const flip of [0, 1]) {
    const b = flip ? play([B, A], opts) : play([A, B], opts);
    s += b.winner === -1 ? 0.5 : b.winner === (flip ? 1 : 0) ? 1 : 0;
    t = Math.max(t, b.time); if (b.reason === 'timeout') to++;
  }
  return { s: s / 2, maxT: t, to };
}

// ---------- compositions ----------
function compositions(lo, hi) {
  const out = [];
  for (let s = 0; s <= MAX_UNITS; s++) for (let p = 0; s + p <= MAX_UNITS; p++) for (let a = 0; s + p + a <= MAX_UNITS; a++) for (let c = 0; s + p + a + c <= MAX_UNITS; c++) {
    if (!(s + p + a + c)) continue;
    const g = costOf([s, p, a, c]);
    if (g >= lo && g <= hi) out.push([s, p, a, c]);
  }
  return out;
}
const isMono = c => c.filter(n => n > 0).length === 1;

// Default quick-battle army as composition counts (reads it back from a fresh battle).
function defaultCounts() {
  const b = createBattle();
  const c = [0, 0, 0, 0];
  for (const r of b.regs) if (r.owner === 0) c[KINDS.indexOf(r.type)]++;
  return c;
}

// ---------- scripted opponents (T5) ----------
const policies = {
  passive: null,
  // everything attacks the nearest enemy at t = 0 and never thinks again
  naive: (b, s) => {
    if (tickOf(b) !== 1) return;
    const foes = b.regs.filter(r => r.owner !== s && live(r));
    for (const r of b.regs) if (r.owner === s) { const t = nearestOf(r, foes); if (t) giveOrder(b, s, [r.id], { t: 'attack', target: t.id }); }
  },
  // A sensible human plan: spears and swords form a line a little ahead of the start, archers stay behind
  // and shoot whatever comes in range, cavalry rides round a flank and hits the archers once the foot has met.
  scripted: (b, s) => {
    const t = tickOf(b);
    const mine = b.regs.filter(r => r.owner === s && live(r)), foes = b.regs.filter(r => r.owner !== s && live(r));
    if (!mine.length || !foes.length) return;
    const dir = s === 0 ? 1 : -1;
    const engaged = mine.some(r => r.state === 'fighting') || foes.some(r => r.state === 'fighting');
    if (t === 1) {
      for (const r of mine) {
        if (r.type === 'cav') giveOrder(b, s, [r.id], { t: 'move', x: r.x + dir * 250, y: r.y < H / 2 ? 50 : H - 50 });
        else if (r.type !== 'archer') giveOrder(b, s, [r.id], { t: 'move', x: r.x + dir * 150, y: r.y });
      }
    }
    if (t % 10 !== 5) return;
    for (const r of mine) {
      const e = nearestOf(r, foes);
      if (r.type === 'archer') {
        if (r.ammo > 0) {
          const inRange = foes.filter(f => dist(r, f) <= 170).sort((a, c) => a.men - c.men || a.id - c.id)[0];
          if (inRange && !(r.order && r.order.t === 'attack' && r.order.target === inRange.id)) giveOrder(b, s, [r.id], { t: 'attack', target: inRange.id });
        } else if (!(r.order && r.order.t === 'attack')) giveOrder(b, s, [r.id], { t: 'attack', target: e.id });
      } else if (r.type === 'cav') {
        if ((engaged || t > 300) && !(r.order && r.order.t === 'attack' && foes.some(f => f.id === r.order.target))) {
          const arch = foes.filter(f => f.type === 'archer');
          const tg = nearestOf(r, arch.length ? arch : foes.filter(f => f.type !== 'spear').length ? foes.filter(f => f.type !== 'spear') : foes);
          giveOrder(b, s, [r.id], { t: 'attack', target: tg.id });
        }
      } else if (r.state !== 'fighting' && (t > 120 || dist(r, e) < 200) && !(r.order && r.order.t === 'attack' && r.order.target === e.id)) {
        giveOrder(b, s, [r.id], { t: 'attack', target: e.id });
      }
    }
  },
};

// ---------- jobs (run in worker threads) ----------
const jobs = {
  // T1: random armies of equal gold. a.shareN[type][bucket] = [wins, n] by unit share, a.shareG by gold share.
  share({ seed, pairs, goldLo, goldHi, tol, jitter }) {
    const rng = prng(seed);
    const minCost = Math.min(...KINDS.map(k => COST[k]));
    const randArmy = gold => {
      const w = KINDS.map(() => rng()), sum = w.reduce((x, y) => x + y);
      const counts = [0, 0, 0, 0];
      let spent = 0, n = 0;
      for (let guard = 0; n < MAX_UNITS && guard < 200; guard++) {
        const x = rng() * sum;
        let k = 0, acc = 0;
        for (; k < 3; k++) { acc += w[k]; if (x < acc) break; }
        if (spent + COST[KINDS[k]] > gold) continue;
        counts[k]++; n++; spent += COST[KINDS[k]];
        if (spent > gold - minCost) break;
      }
      return { counts, spent, n };
    };
    const edges = [0, 0.15, 0.30, 0.45, 0.60, 1.0001];       // bucket 0 is the exact share 0; then (0,15), [15,30) ...
    const bucketOf = sh => (sh <= 0 ? 0 : 1 + edges.slice(1).findIndex(e => sh < e));
    const out = { battles: 0, rejected: 0, s0: 0, dec: 0, shareN: {}, shareG: {} };
    for (const k of KINDS) { out.shareN[k] = edges.map(() => [0, 0]); out.shareG[k] = edges.map(() => [0, 0]); }
    const add = (A, res) => {
      const n = A.counts.reduce((x, y) => x + y, 0);
      KINDS.forEach((k, i) => {
        const sn = A.counts[i] / n, sg = A.counts[i] * COST[k] / A.spent;
        const bn = out.shareN[k][bucketOf(sn)], bg = out.shareG[k][bucketOf(sg)];
        bn[0] += res; bn[1]++; bg[0] += res; bg[1]++;
      });
    };
    for (let done = 0; done < pairs;) {
      const gold = goldLo + Math.floor(rng() * (goldHi - goldLo + 1));
      const A = randArmy(gold), B = randArmy(gold);
      if (!A.n || !B.n || Math.abs(A.spent - B.spent) > tol * Math.max(A.spent, B.spent)) { out.rejected++; continue; }
      done++;
      for (const flip of [0, 1]) {
        const b = flip ? play([army(B.counts), army(A.counts)], { rng, jitter }) : play([army(A.counts), army(B.counts)], { rng, jitter });
        const wA = flip ? 1 : 0;
        const rA = b.winner === -1 ? 0.5 : b.winner === wA ? 1 : 0;
        add(A, rA); add(B, 1 - rA); out.battles++;
        if (b.winner !== -1) { out.dec++; if (b.winner === 0) out.s0++; }
      }
    }
    return out;
  },
  // Round robin slice: pairs = [[i, j], ...] over comps; returns one score per pair (score of i against j).
  pairs({ seed, pairs, comps, rounds, jitter }) {
    const rng = prng(seed);
    const res = [];
    let maxT = 0, to = 0, battles = 0;
    for (const [i, j] of pairs) {
      let s = 0;
      for (let r = 0; r < rounds; r++) { const d = duel(army(comps[i]), army(comps[j]), { rng, jitter }); s += d.s; maxT = Math.max(maxT, d.maxT); to += d.to; battles += 2; }
      res.push(s / rounds);
    }
    return { res, maxT, to, battles };
  },
  // Default army against each opponent composition.
  vsField({ seed, def, field, rounds, jitter }) {
    const rng = prng(seed);
    const res = [];
    for (const f of field) {
      let s = 0;
      for (let r = 0; r < rounds; r++) s += duel(army(def), army(f), { rng, jitter }).s;
      res.push(s / rounds);
    }
    return { res };
  },
  // Mono-type armies at an equal budget.
  matrix({ seed, gold, reps, jitter, rows }) {
    const rng = prng(seed);
    const n = k => Math.max(1, Math.min(MAX_UNITS, Math.round(gold / COST[k])));
    const out = {};
    for (const a of rows) for (const bk of KINDS) {
      if (KINDS.indexOf(bk) < KINDS.indexOf(a)) continue;
      let s = 0;
      for (let r = 0; r < reps; r++) {
        const A = army(KINDS.map(k => (k === a ? n(k) : 0))), B = army(KINDS.map(k => (k === bk ? n(k) : 0)));
        s += duel(A, B, { rng, jitter }).s;
      }
      out[a + ',' + bk] = s / reps;
    }
    return out;
  },
  // T4: identical armies, jitter on every regiment. Reports side 0 share and lengths.
  fair({ seed, n, jitter, random }) {
    const rng = prng(seed);
    const def = defaultCounts();
    const out = { n, s0: 0, s1: 0, draw: 0, to: 0, durs: [] };
    for (let i = 0; i < n; i++) {
      let counts = def;
      if (random) {
        counts = [0, 0, 0, 0];
        const total = 2 + Math.floor(rng() * 9);
        for (let k = 0; k < total; k++) counts[Math.floor(rng() * 4)]++;
      }
      const b = play([army(counts), army(counts)], { rng, jitter });
      if (b.winner === 0) out.s0++; else if (b.winner === 1) out.s1++; else out.draw++;
      if (b.reason === 'timeout') out.to++;
      out.durs.push(b.time);
    }
    return out;
  },
  // T5: bot (seat alternating) against a policy; battle with the default army or random armies of equal gold.
  bot({ seed, n, policy, jitter, random }) {
    const rng = prng(seed);
    const def = defaultCounts();
    const out = { n, win: 0, loss: 0, draw: 0, to: 0, durs: [] };
    for (let i = 0; i < n; i++) {
      const side = i & 1;                                        // seat of the bot
      let A = def, B = def;
      if (random) {
        const gold = 700 + Math.floor(rng() * 700);
        const mk = () => { const c = [0, 0, 0, 0]; let g = 0; for (let t = 0; t < 300 && c.reduce((x, y) => x + y) < MAX_UNITS; t++) { const k = Math.floor(rng() * 4); if (g + COST[KINDS[k]] > gold) continue; c[k]++; g += COST[KINDS[k]]; } return c; };
        A = mk(); B = mk();
      }
      const armies = side === 0 ? [army(A), army(B)] : [army(B), army(A)];
      const ctl = [null, null];
      ctl[side] = botThink; ctl[1 - side] = policies[policy];
      const b = play(armies, { rng, jitter, ctl });
      if (b.reason === 'timeout') out.to++;
      out.durs.push(b.time);
      if (b.winner === -1) out.draw++; else if (b.winner === side) out.win++; else out.loss++;
    }
    return out;
  },
  // T6: AI against AI campaigns from varied starts; battles fought with the real simulation and bots.
  campaign({ seed, n, mode, jitter }) {
    const rng = prng(seed);
    const out = { games: 0, w0: 0, w1: 0, draw: 0, turn_limit: 0, capital: 0, both: 0, turns: [], battles: 0, timeouts: 0, drawnBattles: 0, defWins: 0, defBattles: 0, noWinner: 0 };
    const unit = () => { const k = KINDS[Math.floor(rng() * 4)]; return { type: k, men: rng() < 0.3 ? 1 + Math.floor(rng() * TYPES[k].men) : TYPES[k].men }; };
    for (let g = 0; g < n; g++) {
      const c = camp.newCampaign();
      if (mode === 'random') {            // different random armies and gold for the two seats
        for (const a of c.armies) a.units = Array.from({ length: 2 + Math.floor(rng() * 5) }, unit);
        c.gold = [Math.floor(rng() * 800), Math.floor(rng() * 800)];
      } else if (mode === 'mirror') {     // identical random start for both seats: any bias is the seat's
        const u = Array.from({ length: 2 + Math.floor(rng() * 5) }, unit), gold = Math.floor(rng() * 800);
        for (const a of c.armies) a.units = u.map(x => ({ ...x }));
        c.gold = [gold, gold];
      }
      let safety = 0;
      while (c.winner === null && safety++ < 400) {
        camp.aiTurn(c, 0); camp.aiTurn(c, 1);
        for (const bt of camp.resolveMoves(c)) {
          const a0 = c.armies.find(a => a.id === bt.a0), a1 = c.armies.find(a => a.id === bt.a1);
          if (!a0 || !a1) continue;
          const u = a => a.units.map(x => ({ type: x.type, men: x.men }));
          const b = play([u(a0), u(a1)], { rng, jitter, defender: bt.defender });
          out.battles++; if (b.reason === 'timeout') out.timeouts++; if (b.winner === -1) out.drawnBattles++;
          if (bt.defender !== null) { out.defBattles++; if (b.winner === bt.defender) out.defWins++; }
          camp.applyBattle(c, bt, b.winner, [battleSurvivors(b, 0), battleSurvivors(b, 1)]);
        }
        camp.settle(c);
        if (c.winner !== null) break;
        camp.endTurn(c);
      }
      out.games++;
      if (c.winner === null) { out.noWinner++; continue; }
      out.turns.push(c.turn);
      if (c.winner === 0) out.w0++; else if (c.winner === 1) out.w1++; else out.draw++;
      out[c.endReason === 'turn_limit' ? 'turn_limit' : c.endReason === 'capital' ? 'capital' : 'both']++;
    }
    return out;
  },
};

if (!isMainThread) parentPort.on('message', ({ i, kind, args }) => parentPort.postMessage({ i, res: jobs[kind](args) }));

// ---------- main thread ----------
function parseArgs() {
  const a = { cmd: process.argv[2] || 'help' };
  for (let i = 3; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  return a;
}

class Pool {
  constructor(n) {
    this.workers = Array.from({ length: n }, () => new Worker(SELF, { workerData: { root: ROOT.href }, argv: [] }));
  }
  run(kind, argsList) {
    return new Promise((resolve, reject) => {
      const results = new Array(argsList.length);
      let next = 0, done = 0;
      if (!argsList.length) return resolve(results);
      const feed = w => { if (next < argsList.length) { const i = next++; w.postMessage({ i, kind, args: argsList[i] }); } };
      for (const w of this.workers) {
        w.removeAllListeners('message'); w.removeAllListeners('error');
        w.on('message', ({ i, res }) => { results[i] = res; if (++done === argsList.length) resolve(results); else feed(w); });
        w.on('error', reject);
        feed(w);
      }
    });
  }
  close() { for (const w of this.workers) w.terminate(); }
}

const pct = (x, d = 1) => (x * 100).toFixed(d);
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))];
const se = (p, n) => Math.sqrt(Math.max(1e-9, p * (1 - p)) / Math.max(1, n));

async function main() {
  const a = parseArgs();
  if (a.cmd === 'help' || !['share', 'tourney', 'matrix', 'fair', 'bot', 'campaign', 'all'].includes(a.cmd)) {
    console.log('usage: node tools/balance.mjs <share|tourney|matrix|fair|bot|campaign|all> [--seed N] [--battles N] [--rounds N] [--workers N] [--root DIR] [--jitter PX]');
    return;
  }
  const seed = Number.isFinite(+a.seed) && a.seed !== undefined ? +a.seed : 1;
  const nWorkers = Math.max(1, Math.min(+a.workers || availableParallelism(), 64));
  const jitter = a.jitter !== undefined ? +a.jitter : 6;
  const pool = new Pool(nWorkers);
  const want = c => a.cmd === c || a.cmd === 'all';
  const split = (total, parts) => Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0)).filter(x => x > 0);
  const out = {};
  const costLine = KINDS.map(k => `${k} ${COST[k]}g/${TYPES[k].men}men`).join('  ');
  console.log(`legio balance | root ${fileURLToPath(ROOT)} | seed ${seed} | ${nWorkers} workers | jitter ${jitter}\ncosts: ${costLine}\n`);
  try {
    if (want('share')) await cmdShare();
    if (want('tourney')) await cmdTourney();
    if (want('matrix')) await cmdMatrix();
    if (want('fair')) await cmdFair();
    if (want('bot')) await cmdBot();
    if (want('campaign')) await cmdCampaign();
  } finally { pool.close(); }
  if (a.json) console.log('JSON ' + JSON.stringify(out));

  async function cmdShare() {
    const battles = +a.battles || 20000, lo = +(a.goldlo || 600), hi = +(a.goldhi || 1600), tol = +(a.tol || 0.06);
    const chunks = split(Math.ceil(battles / 2), nWorkers * 4);
    const rs = await pool.run('share', chunks.map((pairs, i) => ({ seed: mix(seed, i), pairs, goldLo: lo, goldHi: hi, tol, jitter })));
    const labels = ['0%', '1-15%', '15-30%', '30-45%', '45-60%', '60-100%'];
    const tot = { battles: 0, rejected: 0, s0: 0, dec: 0 };
    for (const r of rs) for (const k of ['battles', 'rejected', 's0', 'dec']) tot[k] += r[k];
    console.log(`T1  win rate by unit share of the army, random armies of equal gold (${lo}-${hi}, spent gold within ${pct(tol, 0)}%)`);
    console.log(`    ${tot.battles} battles (${tot.battles * 2} army samples), ${tot.rejected} army pairs rejected for unequal gold, seat 0 won ${pct(tot.s0 / tot.dec)}% of decisive battles`);
    const table = (title, key) => {
      console.log(`    by ${title}:`.padEnd(8) + labels.map(l => l.padStart(15)).join(''));
      const sum = {};
      for (const k of KINDS) {
        const row = labels.map((_, bi) => {
          let w = 0, n = 0;
          for (const r of rs) { w += r[key][k][bi][0]; n += r[key][k][bi][1]; }
          return { p: n ? w / n : NaN, n };
        });
        sum[k] = row;
        console.log(('    ' + k).padEnd(12) + row.map(x => (isNaN(x.p) ? '-' : pct(x.p, 0) + '% n=' + x.n).padStart(15)).join(''));
      }
      return sum;
    };
    const byN = table('unit-count share', 'shareN');
    table('gold share', 'shareG');
    // Coarse buckets of the target: 1-30% and 30-60%.
    console.log('    target buckets (unit-count share), standard error of each figure at most:');
    let worst = 0, lo35 = 1, hi65 = 0;
    for (const k of KINDS) {
      const part = (idx) => { let w = 0, n = 0; for (const r of rs) for (const bi of idx) { w += r.shareN[k][bi][0]; n += r.shareN[k][bi][1]; } return { p: w / n, n }; };
      const c1 = part([1, 2]), c2 = part([3, 4]);
      console.log(`      ${k.padEnd(7)} 1-30%: ${pct(c1.p)}% (n=${c1.n})   30-60%: ${pct(c2.p)}% (n=${c2.n})`);
      for (const bi of [1, 2, 3, 4]) { const x = byN[k][bi]; if (x.n > 0) { lo35 = Math.min(lo35, x.p); hi65 = Math.max(hi65, x.p); worst = Math.max(worst, se(x.p, x.n)); } }
    }
    console.log(`      lowest / highest fine bucket (1-60%): ${pct(lo35)}% / ${pct(hi65)}%  (std err up to ${pct(worst)} points)`);
    out.share = { lo: lo35, hi: hi65, byN: Object.fromEntries(KINDS.map(k => [k, byN[k].map(x => [x.p, x.n])])), seat0: tot.s0 / tot.dec };
    console.log('');
  }

  async function cmdTourney() {
    const rounds = +(a.rounds || 1);
    const comps = compositions(1050 * 0.95, 1050 * 1.05);
    const N = comps.length;
    const all = []; for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) all.push([i, j]);
    const per = Math.ceil(all.length / (nWorkers * 6));
    const slices = []; for (let i = 0; i < all.length; i += per) slices.push(all.slice(i, i + per));
    const rs = await pool.run('pairs', slices.map((pairs, i) => ({ seed: mix(seed + 7, i), pairs, comps, rounds, jitter })));
    const M = Array.from({ length: N }, () => new Float64Array(N));
    let maxT = 0, to = 0, battles = 0;
    rs.forEach((r, si) => { r.res.forEach((s, k) => { const [i, j] = slices[si][k]; M[i][j] = s; M[j][i] = 1 - s; }); maxT = Math.max(maxT, r.maxT); to += r.to; battles += r.battles; });
    const avg = comps.map((c, i) => { let s = 0; for (let j = 0; j < N; j++) if (j !== i) s += M[i][j]; return { c, i, avg: s / (N - 1), cost: costOf(c), beats: M[i].reduce((n, v, j) => n + (j !== i && v < 0.5 ? 1 : 0), 0) }; });
    avg.sort((x, y) => y.avg - x.avg);
    const fmt = x => `${JSON.stringify(x.c)} avg ${x.avg.toFixed(2)} cost ${x.cost} loses to ${x.beats} comps`;
    console.log(`T2  round robin of ${N} compositions costing ${(1050 * 0.95).toFixed(1)}-${(1050 * 1.05).toFixed(1)} gold ([sword,spear,archer,cav]); ${battles} battles, ${to} time-outs, longest ${maxT.toFixed(0)} s`);
    console.log('    top 8:');
    avg.slice(0, 8).forEach(x => console.log('      ' + fmt(x)));
    console.log('    bottom 8:');
    avg.slice(-8).forEach(x => console.log('      ' + fmt(x)));
    const non = avg.filter(x => !isMono(x.c)), mono = avg.filter(x => isMono(x.c));
    const hi = non.filter(x => x.avg > 0.65).length, loN = non.filter(x => x.avg < 0.30).length;
    console.log(`    non-mono: best ${non[0].avg.toFixed(2)} worst ${non[non.length - 1].avg.toFixed(2)} spread ${(non[0].avg - non[non.length - 1].avg).toFixed(2)}; above 0.65: ${hi}, below 0.30: ${loN} of ${non.length}`);
    console.log('    mono armies: ' + mono.map(x => `${KINDS[x.c.findIndex(n => n > 0)]}x${Math.max(...x.c)} ${x.avg.toFixed(2)}`).join(', ') + `  (lowest ${mono.length ? Math.min(...mono.map(x => x.avg)).toFixed(2) : '-'})`);
    const m = arr => arr.reduce((s, x) => s + x.avg, 0) / Math.max(1, arr.length);
    console.log('    average win rate when the type is absent / present: ' + KINDS.map((k, i) => `${k} ${m(avg.filter(x => x.c[i] === 0)).toFixed(2)}/${m(avg.filter(x => x.c[i] > 0)).toFixed(2)}`).join('  '));
    console.log(`    compositions that lose to no other composition: ${avg.filter(x => x.beats === 0).length}`);
    out.tourney = { best: non[0].avg, worst: non[non.length - 1].avg, hi, lo: loN, count: N, nonMono: non.map(x => [x.c, x.avg, x.cost]), mono: mono.map(x => [x.c, x.avg]), timeouts: to, maxT };

    // T3: default army against compositions of similar cost
    const def = defaultCounts(), dcost = costOf(def);
    const field = compositions(dcost * 0.95, dcost * 1.05).filter(c => c.join() !== def.join());
    const fr = await pool.run('vsField', split(field.length, nWorkers * 2).map((cnt, i, arr) => {
      const from = arr.slice(0, i).reduce((x, y) => x + y, 0);
      return { seed: mix(seed + 11, i), def, field: field.slice(from, from + cnt), rounds: Math.max(rounds, 4), jitter };
    }));
    const sc = fr.flatMap(r => r.res);
    const mean = sc.reduce((x, y) => x + y, 0) / sc.length;
    const beaten = sc.filter(v => v < 0.5).length;
    console.log(`T3  default army ${JSON.stringify(def)} (cost ${dcost}) against ${field.length} compositions costing within 5% of it: mean win rate ${mean.toFixed(3)}, loses to ${beaten} of them`);
    // also against the T2 field, for reference
    const di = comps.findIndex(c => c.join() === def.join());
    out.def = { mean, beaten, field: field.length, cost: dcost };
    console.log('');
  }

  async function cmdMatrix() {
    const reps = +(a.rounds || 20);
    const golds = (a.golds || '600,700,800,900,1000,1100,1200,1300,1400,1500').split(',').map(Number);
    console.log(`T7  pairwise win rate of single-type armies at equal gold (row beats column; both seatings, draws count half),`);
    console.log(`    averaged over the budgets ${golds.join(', ')} (armies are whole units, so each budget is spent to within one unit; the average evens that out)`);
    out.matrix = {};
    const tot = {}; let nTot = 0;
    for (const gold of golds) {
      const parts = split(reps, Math.min(reps, nWorkers));
      const rs = await pool.run('matrix', parts.map((rp, i) => ({ seed: mix(seed + 13 + gold, i), gold, reps: rp, jitter, rows: KINDS })));
      parts.forEach((rp, i) => { for (const key of Object.keys(rs[i])) tot[key] = (tot[key] || 0) + rs[i][key] * rp; });
      nTot += reps;
    }
    const get = (x, y) => { const i = KINDS.indexOf(x), j = KINDS.indexOf(y); return i <= j ? tot[x + ',' + y] / nTot : 1 - tot[y + ',' + x] / nTot; };
    console.log('             ' + KINDS.map(k => k.padStart(8)).join(''));
    for (const x of KINDS) console.log(('    ' + x).padEnd(13) + KINDS.map(y => (x === y ? '-' : pct(get(x, y), 0) + '%').padStart(8)).join(''));
    out.matrix = Object.fromEntries(KINDS.flatMap(x => KINDS.filter(y => y !== x).map(y => [x + '>' + y, get(x, y)])));
    console.log('');
  }

  async function cmdFair() {
    const n = +a.battles || 20000;
    for (const [label, random, jit] of [['default army', false, jitter], ['default army, jitter 15', false, 15], ['random identical armies', true, jitter]]) {
      const rs = await pool.run('fair', split(n, nWorkers * 2).map((cnt, i) => ({ seed: mix(seed + 17 + (random ? 1 : 0) + jit, i), n: cnt, jitter: jit, random })));
      const t = { s0: 0, s1: 0, draw: 0, to: 0 }; const durs = [];
      for (const r of rs) { t.s0 += r.s0; t.s1 += r.s1; t.draw += r.draw; t.to += r.to; for (const d of r.durs) durs.push(d); }
      durs.sort((x, y) => x - y);
      const dec = t.s0 + t.s1;
      console.log(`T4  ${label}: ${n} battles, side 0 won ${pct(t.s0 / dec, 2)}% of ${dec} decisive (+-${pct(se(0.5, dec), 2)}), draws ${t.draw}, time-outs ${t.to}, length min/median/p90/max ${durs[0].toFixed(1)}/${q(durs, 0.5).toFixed(1)}/${q(durs, 0.9).toFixed(1)}/${durs[durs.length - 1].toFixed(1)} s`);
    }
    console.log('');
  }

  async function cmdBot() {
    const n = +a.battles || 4000;
    for (const [policy, random] of [['passive', false], ['passive', true], ['naive', false], ['naive', true], ['scripted', false], ['scripted', true]]) {
      const rs = await pool.run('bot', split(n, nWorkers * 2).map((cnt, i) => ({ seed: mix(seed + 19 + (random ? 5 : 0), i), n: cnt, policy, jitter, random })));
      const t = { win: 0, loss: 0, draw: 0, to: 0 }; const durs = [];
      for (const r of rs) { for (const k of Object.keys(t)) t[k] += r[k]; for (const d of r.durs) durs.push(d); }
      durs.sort((x, y) => x - y);
      const label = `${policy} (${random ? 'random armies, equal gold' : 'default army'})`;
      console.log(`T5  bot vs ${label.padEnd(44)} bot wins ${pct(t.win / n)}%  loses ${pct(t.loss / n)}%  draws ${pct(t.draw / n)}%  (${policy} wins ${pct(t.loss / n)}%)  time-outs ${t.to}  median ${q(durs, 0.5).toFixed(0)} s  n=${n}`);
    }
    console.log('');
  }

  async function cmdCampaign() {
    const n = +a.battles || 600;
    for (const mode of ['mirror', 'random', 'default']) {
      const games = mode === 'default' ? Math.min(n, 1) : n;
      const rs = await pool.run('campaign', split(games, nWorkers * 2).map((cnt, i) => ({ seed: mix(seed + 23, i), n: cnt, mode, jitter })));
      const t = { games: 0, w0: 0, w1: 0, draw: 0, turn_limit: 0, capital: 0, both: 0, battles: 0, timeouts: 0, drawnBattles: 0, defWins: 0, defBattles: 0, noWinner: 0 };
      const turns = [];
      for (const r of rs) { for (const k of Object.keys(t)) t[k] += r[k]; for (const x of r.turns) turns.push(x); }
      turns.sort((x, y) => x - y);
      const dec = t.w0 + t.w1;
      console.log(`T6  campaigns, start '${mode}': ${t.games} games | seat 0 won ${t.w0}, seat 1 ${t.w1}, drawn ${t.draw} (seat 0 ${dec ? pct(t.w0 / dec) : '-'}% of decisive, +-${pct(se(0.5, Math.max(1, dec)))}) | ended by capital ${t.capital}, turn limit ${t.turn_limit}, both capitals ${t.both}, unfinished ${t.noWinner} | turns min/median/p90/max ${turns.length ? [q(turns, 0), q(turns, 0.5), q(turns, 0.9), q(turns, 1)].join('/') : '-'} | battles ${t.battles}, time-outs ${t.timeouts}, drawn ${t.drawnBattles}, defender won ${t.defBattles ? pct(t.defWins / t.defBattles, 0) : '-'}%`);
    }
    console.log('');
  }
}

if (isMainThread) await main();
