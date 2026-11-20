import { WebSocket } from 'ws';
const mk = () => new Promise(r => { const w = new WebSocket('ws://localhost:3000'); w.on('open', () => r(w)); });
// practice: should start after ready and produce snaps
const p = await mk(); let snaps = 0, started = false;
p.on('message', raw => { const m = JSON.parse(raw); if (m.t === 'room' && m.players.length === 2 && !started) { started = true; p.send('{"t":"ready"}'); } if (m.t === 'snap') snaps++; });
p.send('{"t":"practice","name":"Solo"}');
await new Promise(r => setTimeout(r, 2000));
console.log('practice snaps', snaps);
// disconnect mid-battle: opponent should get end with them as winner
const a = await mk(), b = await mk(); let code, endB;
a.on('message', raw => { const m = JSON.parse(raw); if (m.t === 'room' && !code) { code = m.code; b.send(JSON.stringify({ t: 'join', code, name: 'B' })); } if (m.t === 'room' && m.players.length === 2 && m.phase === 'lobby') { a.send('{"t":"ready"}'); b.send('{"t":"ready"}'); } });
b.on('message', raw => { const m = JSON.parse(raw); if (m.t === 'end') endB = m.winner; });
a.send('{"t":"create","name":"A"}');
await new Promise(r => setTimeout(r, 1000)); a.close();
await new Promise(r => setTimeout(r, 500));
console.log('disconnect -> B sees winner', endB, '(expect 1)');
// bad input shouldn't crash
const c = await mk(); c.send('garbage'); c.send('{"t":"move","ids":"x"}'); c.send('{"t":"join","code":"ZZZZ"}');
await new Promise(r => setTimeout(r, 300));
const res = await fetch('http://localhost:3000/'); console.log('GET / ->', res.status, (await fetch('http://localhost:3000/../server.js')).status);
process.exit(0);
