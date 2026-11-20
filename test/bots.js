import { WebSocket } from 'ws';
const URL = process.env.URL || 'ws://localhost:3000';
const mk = () => new Promise(r => { const w = new WebSocket(URL); w.on('open', () => r(w)); });
const [a, b] = await Promise.all([mk(), mk()]);
let code, start = { a: false, b: false }, snapA, endMsg = {}, errs = [];
const handle = (key, w) => w.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.t === 'room' && key === 'a' && !code) { code = m.code; b.send(JSON.stringify({ t: 'join', code, name: 'Bee' })); }
  if (m.t === 'room' && m.players.length === 2 && m.phase === 'lobby' && key === 'a' && !start.a) { start.a = true; a.send('{"t":"ready"}'); b.send('{"t":"ready"}'); }
  if (m.t === 'error') errs.push(m.msg);
  if (m.t === 'snap') {
    if (key === 'a') snapA = m;
    // each side: attack nearest enemy with idle units every ~2s
    if (Math.round(m.time * 20) % 40 === 0) {
      const me = key === 'a' ? 0 : 1;
      const mine = m.regs.filter(r => r[1] === me && r[8] !== 'dead' && r[8] !== 'rout');
      const foes = m.regs.filter(r => r[1] !== me && r[8] !== 'dead' && r[8] !== 'rout');
      for (const r of mine) { let best, bd = 1e9; for (const f of foes) { const d = Math.hypot(f[3]-r[3], f[4]-r[4]); if (d < bd) { bd = d; best = f; } }
        if (best) w.send(JSON.stringify({ t: 'attack', ids: [r[0]], target: best[0] })); }
    }
  }
  if (m.t === 'end') endMsg[key] = m.winner;
});
handle('a', a); handle('b', b);
a.send(JSON.stringify({ t: 'create', name: 'Ay' }));
const t0 = Date.now();
while (endMsg.a === undefined && Date.now() - t0 < 180000) await new Promise(r => setTimeout(r, 200));
console.log('code', code, 'end', endMsg, 'sim time', snapA?.time, 'errors', errs);
const alive = snapA.regs.filter(r => r[8] !== 'dead' && r[8] !== 'rout').reduce((o, r) => (o[r[1]] = (o[r[1]] || 0) + r[6], o), {});
console.log('survivors by side', alive);
process.exit(endMsg.a !== undefined && endMsg.a === endMsg.b ? 0 : 1);
