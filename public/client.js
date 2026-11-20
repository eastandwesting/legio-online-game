const $ = id => document.getElementById(id);
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
let me = 0, W = 1600, H = 900, types = {}, snap = null, prev = null, snapAt = 0, selected = new Set(), inBattle = false;
let inCampaign = false, drag = null, mouse = { x: 0, y: 0 };

const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
const name = () => $('name').value.trim() || 'Commander';
$('btnCreate').onclick = () => send({ t: 'create', name: name() });
$('btnCamp').onclick = () => send({ t: 'create', name: name(), mode: 'campaign' });
$('btnCampAI').onclick = () => send({ t: 'practice', name: name(), mode: 'campaign' });
$('btnPractice').onclick = () => send({ t: 'practice', name: name() });
$('btnJoin').onclick = () => send({ t: 'join', code: $('code').value, name: name() });
$('btnReady').onclick = () => { send({ t: 'ready' }); $('btnReady').disabled = true; };
$('btnAgain').onclick = () => { $('end').style.display = 'none'; $('camp').style.display = 'none'; $('game').style.display = 'none'; $('lobby').style.display = 'block'; inBattle = false; $('btnReady').disabled = false; };

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.t === 'error') $('err').textContent = m.msg;
  if (m.t === 'room') {
    $('err').textContent = '';
    $('menu').style.display = 'none'; $('roomView').style.display = 'block';
    $('roomCode').textContent = m.code; $('modeLabel').textContent = m.mode === 'campaign' ? 'Campaign' : 'Single battle'; inCampaign = false; me = m.you;
    $('players').innerHTML = m.players.map((p, i) =>
      `<div class="pl">${i === 0 ? '🦅' : '🏺'} ${p.name.replace(/</g, '')} ${i === m.you ? '(you)' : ''} — ${p.ready ? 'ready' : 'waiting'}</div>`).join('') +
      (m.players.length < 2 ? '<div class="pl">Waiting for an opponent… share the code.</div>' : '');
    if (m.phase !== 'battle') $('btnReady').disabled = m.players[m.you] && m.players[m.you].ready;
  }
  if (m.t === 'start') {
    me = m.you; W = m.W; H = m.H; types = m.types; snap = null; prev = null; selected.clear(); inBattle = true;
    $('lobby').style.display = 'none'; $('camp').style.display = 'none'; $('game').style.display = 'block'; $('btnAgain').style.display = inCampaign ? 'none' : 'inline-block'; $('end').style.display = 'none';
    resize();
  }
  if (m.t === 'camp') { inCampaign = true; inBattle = false; $('lobby').style.display = 'none'; $('game').style.display = 'none'; $('camp').style.display = 'block'; $('end').style.display = 'none'; renderCamp(m); }
  if (m.t === 'snap') { prev = snap; snap = m; snapAt = performance.now(); }
  if (m.t === 'end') {
    $('endText').textContent = m.winner === me ? 'VICTORY' : m.winner === -1 ? 'DRAW' : 'DEFEAT';
    $('endText').textContent += m.forfeit ? ' (opponent left)' : ''; if (m.forfeit) $('btnAgain').style.display = 'inline-block'; $('end').style.display = 'flex';
  }
};

const cv = $('cv'), ctx = cv.getContext('2d');
let scale = 1, ox = 0, oy = 0;
function resize() {
  cv.width = innerWidth; cv.height = innerHeight;
  scale = Math.min(cv.width / W, cv.height / H); ox = (cv.width - W * scale) / 2; oy = (cv.height - H * scale) / 2;
}
addEventListener('resize', resize);
const toWorld = (px, py) => ({ x: (px - ox) / scale, y: (py - oy) / scale });
const R = a => ({ id: a[0], owner: a[1], type: a[2], x: a[3], y: a[4], face: a[5], men: a[6], morale: a[7], state: a[8], ammo: a[9], engaged: a[10] });

function regimentAt(x, y, owner) {
  if (!snap) return null;
  let best = null, bd = 28;
  for (const a of snap.regs) { const r = R(a); if (r.state === 'dead' || (owner !== undefined && r.owner !== owner)) continue;
    const d = Math.hypot(r.x - x, r.y - y); if (d < bd) { bd = d; best = r; } }
  return best;
}

cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('mousedown', e => {
  if (!inBattle) return;
  const w = toWorld(e.offsetX, e.offsetY);
  if (e.button === 0) drag = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, shift: e.shiftKey };
  if (e.button === 2 && selected.size) {
    const ids = [...selected];
    const foe = regimentAt(w.x, w.y);
    if (foe && foe.owner !== me) send({ t: 'attack', ids, target: foe.id });
    else {
      // spread ordered units in a loose line so they don't stack
      ids.forEach((id, i) => send({ t: 'move', ids: [id], x: w.x, y: w.y + (i - (ids.length - 1) / 2) * 34 }));
    }
  }
});
cv.addEventListener('mousemove', e => { mouse = toWorld(e.offsetX, e.offsetY); if (drag) { drag.x1 = mouse.x; drag.y1 = mouse.y; } });
addEventListener('mouseup', e => {
  if (!drag || e.button !== 0) return;
  const d = drag; drag = null;
  if (!d.shift) selected.clear();
  const small = Math.abs(d.x1 - d.x0) < 6 && Math.abs(d.y1 - d.y0) < 6;
  if (small) { const r = regimentAt(d.x0, d.y0, me); if (r) selected.add(r.id); return; }
  const [xa, xb] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)], [ya, yb] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
  for (const a of snap ? snap.regs : []) { const r = R(a);
    if (r.owner === me && r.state !== 'dead' && r.state !== 'rout' && r.x >= xa && r.x <= xb && r.y >= ya && r.y <= yb) selected.add(r.id); }
});
addEventListener('keydown', e => {
  if (!inBattle) return;
  if (e.key === 's' || e.key === 'S') send({ t: 'stop', ids: [...selected] });
  if (e.key === 'a' && snap) { selected.clear(); snap.regs.forEach(a => { const r = R(a); if (r.owner === me && r.state !== 'dead' && r.state !== 'rout') selected.add(r.id); }); }
});

const COL = [['#b3262a', '#e8c15a'], ['#2a4f9b', '#d9d2c0']];
function draw() {
  requestAnimationFrame(draw);
  if (!inBattle) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#2f3a1e'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  ctx.fillStyle = '#566a33'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#ffffff10'; ctx.setLineDash([10, 14]); ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]);
  if (!snap) return;
  const t = prev ? Math.min(1, (performance.now() - snapAt) / 50) : 1;
  const pm = new Map(); if (prev) prev.regs.forEach(a => pm.set(a[0], a));
  let hud = '';
  for (const a of snap.regs) {
    const r = R(a); if (r.state === 'dead') continue;
    const p = pm.get(r.id); if (p) { r.x = p[3] + (r.x - p[3]) * t; r.y = p[4] + (r.y - p[4]) * t; }
    const T = types[r.type]; if (!T) continue;
    const [c1, c2] = COL[r.owner];
    const n = Math.max(1, Math.round(r.men / 3));
    const cols = r.type === 'archer' ? 5 : r.type === 'cav' ? 4 : 6;
    ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(r.face);
    ctx.globalAlpha = r.state === 'rout' ? 0.5 : 1;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols), col = i % cols;
      const px = -row * 7, py = (col - (cols - 1) / 2) * 7;
      ctx.fillStyle = r.type === 'cav' ? c2 : c1; ctx.beginPath();
      ctx.arc(px, py, r.type === 'cav' ? 4 : 3, 0, 7); ctx.fill();
      ctx.strokeStyle = '#000a'; ctx.stroke();
    }
    ctx.restore();
    // ranged fire lines
    if (r.engaged && T.ranged && r.ammo > 0) { const tg = snap.regs.find(q => q[0] === r.engaged);
      if (tg) { ctx.strokeStyle = '#fff6'; ctx.beginPath(); ctx.moveTo(r.x, r.y); ctx.lineTo(tg[3], tg[4]); ctx.stroke(); } }
    // selection ring + banner bar
    if (selected.has(r.id)) { ctx.strokeStyle = '#7dff7d'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r.x, r.y, 26, 0, 7); ctx.stroke(); ctx.lineWidth = 1; }
    ctx.fillStyle = '#000a'; ctx.fillRect(r.x - 18, r.y - 34, 36, 5);
    ctx.fillStyle = r.morale > 50 ? '#6dd36d' : r.morale > 20 ? '#e8c15a' : '#e0453a';
    ctx.fillRect(r.x - 18, r.y - 34, 36 * Math.max(0, r.morale) / 100, 5);
    ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${r.men}`, r.x, r.y - 38);
    if (r.owner === me && r.state !== 'rout') hud += '';
  }
  if (drag) { ctx.strokeStyle = '#7dff7d'; ctx.strokeRect(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)); }
  const mine = snap.regs.filter(a => a[1] === me && a[8] !== 'dead' && a[8] !== 'rout');
  const theirs = snap.regs.filter(a => a[1] !== me && a[8] !== 'dead' && a[8] !== 'rout');
  $('hud').innerHTML = `You: ${mine.reduce((s, a) => s + a[6], 0)} men (${mine.length} units) &nbsp;|&nbsp; Enemy: ${theirs.reduce((s, a) => s + a[6], 0)} men (${theirs.length} units) &nbsp;|&nbsp; ${snap.time.toFixed(0)}s &nbsp;|&nbsp; You are ${me === 0 ? 'Red (left)' : 'Blue (right)'}`;
}
draw();
