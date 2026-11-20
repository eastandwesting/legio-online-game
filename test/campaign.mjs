import { WebSocket } from 'ws';
const w = new WebSocket('ws://localhost:3000'); await new Promise(r => w.on('open', r));
const send = o => w.send(JSON.stringify(o));
const PATH = [0, 2, 4, 6, 7, 10, 12]; // march west->east
let me = 0, started = false, battles = 0, turns = 0, final = null, errs = [], lastTurn = 0;
w.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.t === 'room' && !started && m.players.length === 2) { started = true; send({ t: 'ready' }); }
  if (m.t === 'error') errs.push(m.msg);
  if (m.t === 'start') { battles++; console.log('battle', battles, 'started'); }
  if (m.t === 'snap' && Math.round(m.time * 20) % 40 === 0) {
    const mine = m.regs.filter(r => r[1] === 0 && r[8] !== 'dead' && r[8] !== 'rout'), foes = m.regs.filter(r => r[1] === 1 && r[8] !== 'dead' && r[8] !== 'rout');
    for (const r of mine) { let b, bd = 1e9; for (const f of foes) { const d = Math.hypot(f[3]-r[3], f[4]-r[4]); if (d < bd) { bd = d; b = f; } } if (b) send({ t: 'attack', ids: [r[0]], target: b[0] }); }
  }
  if (m.t === 'camp') {
    if (m.winner !== null) { final = m; return; }
    if (m.phase === 'orders' && !m.ready[0] && m.turn !== lastTurn) {
      lastTurn = m.turn; turns++;
      for (const t of ['sword', 'spear', 'archer', 'cav', 'sword', 'sword']) if (m.gold >= m.cost[t]) send({ t: 'recruit', prov: 0, type: t });
      setTimeout(() => {
        const a = m.armies.find(x => x.owner === 0), e = m.armies.find(x => x.owner === 1);
        if (a && e && m.units >= 6) {
          const adj = i => m.edges.filter(x => x.includes(i)).map(x => x[0] === i ? x[1] : x[0]);
          const prev = new Map([[a.prov, null]]), q = [a.prov];
          while (q.length) { const u = q.shift(); for (const v of adj(u)) if (!prev.has(v)) { prev.set(v, u); q.push(v); } }
          let n = e.prov; if (n !== a.prov) { while (prev.get(n) !== a.prov) n = prev.get(n); send({ t: 'cmove', army: a.id, to: n }); }
        }
        send({ t: 'endturn' });
      }, 100);
    }
  }
});
send({ t: 'practice', name: 'Tester', mode: 'campaign' });
const t0 = Date.now();
while (!final && Date.now() - t0 < 420000) await new Promise(r => setTimeout(r, 500));
console.log('winner', final?.winner, 'turns', turns, 'battles', battles, 'errors', errs);
console.log(final ? final.log.join('\n') : 'NO RESULT');
process.exit(final ? 0 : 1);
