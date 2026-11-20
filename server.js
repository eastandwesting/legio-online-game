import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createBattle, giveOrder, step, snapshot, battleSurvivors, TICK, TYPES, W, H } from './sim.js';
import * as C from './campaign.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
const rooms = new Map();

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const code = () => { let c; do c = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(c)); return c; };
const cleanName = n => String(n || 'Commander').replace(/[^\w \-]/g, '').slice(0, 16) || 'Commander';

function roomInfo(room) {
  return { t: 'room', code: room.code, phase: room.phase, mode: room.mode,
    players: room.players.map(p => ({ name: p.name, ready: p.ready, bot: !!p.bot })) };
}
function broadcastRoom(room) {
  room.players.forEach((p, i) => send(p.ws, { ...roomInfo(room), you: i }));
}

// ---------- live battles ----------
// armies: optional [units0, units1] (campaign); onEnd(winner, battle) overrides the default lobby return.
function startBattle(room, armies, onEnd) {
  room.battle = createBattle(armies);
  room.phase = 'battle';
  room.onBattleEnd = onEnd || null;
  room.players.forEach((p, i) => send(p.ws, { t: 'start', you: i, W, H, types: TYPES }));
  clearInterval(room.timer);
  room.timer = setInterval(() => {
    step(room.battle);
    if (room.bot) botThink(room);
    const snap = { t: 'snap', ...snapshot(room.battle) };
    room.players.forEach(p => send(p.ws, snap));
    if (room.battle.over) endBattle(room, room.battle.winner);
  }, TICK * 1000);
}

function endBattle(room, winner) {
  clearInterval(room.timer); room.timer = null;
  room.players.forEach(p => send(p.ws, { t: 'end', winner }));
  const cb = room.onBattleEnd; room.onBattleEnd = null;
  if (cb) { room.phase = 'between'; setTimeout(() => room.alive && cb(winner, room.battle), 3500); return; }
  room.phase = 'over';
  room.players.forEach(p => { p.ready = !!p.bot; });
  broadcastRoom(room);
}

// Simple practice-bot: every second, send idle regiments at the nearest enemy.
function botThink(room) {
  if (Math.round(room.battle.time * 20) % 20 !== 0) return;
  const b = room.battle;
  const foes = b.regs.filter(r => r.owner === 0 && r.state !== 'dead' && r.state !== 'rout');
  for (const r of b.regs.filter(r => r.owner === 1 && r.state !== 'dead' && r.state !== 'rout')) {
    if (r.order) continue;
    let best = null, bd = Infinity;
    for (const f of foes) { const d = Math.hypot(f.x - r.x, f.y - r.y); if (d < bd) { bd = d; best = f; } }
    if (best) giveOrder(b, 1, [r.id], { t: 'attack', target: best.id });
  }
}

// ---------- campaign ----------
function campView(room, p) {
  const c = room.camp;
  return { t: 'camp', you: p, turn: c.turn, gold: c.gold[p], winner: c.winner, log: c.log.slice(-8),
    owner: c.owner, provs: C.PROVS, edges: C.EDGES, cost: C.COST, capital: C.CAPITAL, maxUnits: C.MAX_UNITS,
    armies: c.armies.map(a => ({ id: a.id, owner: a.owner, prov: a.prov, units: a.units })),
    moves: c.moves[p], ready: c.ready, phase: room.campPhase, units: C.totalUnits(c, p),
    opponent: room.players[1 - p] ? room.players[1 - p].name : '' };
}
function sendCamp(room) { room.players.forEach((p, i) => send(p.ws, campView(room, i))); }

function startCampaign(room) {
  room.camp = C.newCampaign(); room.campPhase = 'orders'; room.phase = 'campaign';
  room.players.forEach(p => { p.ready = !!p.bot; });
  campBotOrders(room); sendCamp(room);
}
function campBotOrders(room) {
  room.players.forEach((p, i) => { if (p.bot) { C.aiTurn(room.camp, i); room.camp.ready[i] = true; } });
}

function resolveTurn(room) {
  const c = room.camp; room.campPhase = 'resolving';
  const battles = C.resolveMoves(c);
  sendCamp(room);
  const next = () => {
    if (!room.alive) return;
    const b = battles.shift();
    if (!b) return finishTurn(room);
    const a0 = c.armies.find(a => a.id === b.a0), a1 = c.armies.find(a => a.id === b.a1);
    room.campPhase = 'battle';
    c.log.push(`Armies clash at ${C.PROVS[b.prov].name}!`); sendCamp(room);
    startBattle(room, [a0.units.slice(0, C.MAX_UNITS), a1.units.slice(0, C.MAX_UNITS)], (winner, bat) => {
      C.applyBattle(c, b, winner, [battleSurvivors(bat, 0), battleSurvivors(bat, 1)]);
      next();
    });
  };
  setTimeout(next, 1200);
}
function finishTurn(room) {
  const c = room.camp;
  C.settle(c);
  if (c.winner !== null) {
    room.phase = 'over'; room.campPhase = 'over';
    sendCamp(room);
    room.players.forEach(p => { p.ready = !!p.bot; });
    broadcastRoom(room);
    return;
  }
  C.endTurn(c); room.campPhase = 'orders'; room.phase = 'campaign';
  campBotOrders(room); sendCamp(room);
}

function leave(ws) {
  const room = ws.room; if (!room) return;
  const idx = room.players.findIndex(p => p.ws === ws);
  ws.room = null;
  if (idx < 0) return;
  room.players[idx].ws = null;
  clearInterval(room.timer); room.timer = null; room.onBattleEnd = null;
  const other = room.players.find(p => p.ws);
  if (!other) { room.alive = false; rooms.delete(room.code); return; }
  if (room.phase === 'battle' || room.phase === 'campaign' || room.phase === 'between') {
    // the player who stayed wins by forfeit
    send(other.ws, { t: 'end', winner: room.players.indexOf(other), forfeit: true });
  }
  room.players = room.players.filter(p => p.ws);
  room.bot = false; room.camp = null; room.phase = 'lobby';
  room.players.forEach(p => { p.ready = false; });
  broadcastRoom(room);
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room;

    if (m.t === 'create' || m.t === 'practice') {
      if (room) return;
      const r = { code: code(), phase: 'lobby', mode: m.mode === 'campaign' ? 'campaign' : 'battle', alive: true,
        players: [{ ws, name: cleanName(m.name), ready: false }], battle: null, timer: null, bot: false, camp: null };
      rooms.set(r.code, r); ws.room = r;
      if (m.t === 'practice') {
        r.bot = true; r.players.push({ ws: null, name: 'Rival Legate (AI)', ready: true, bot: true });
      }
      return broadcastRoom(r);
    }
    if (m.t === 'join') {
      if (room) return;
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r || r.players.length >= 2 || r.phase !== 'lobby') return send(ws, { t: 'error', msg: 'Room not found or full.' });
      r.players.push({ ws, name: cleanName(m.name), ready: false }); ws.room = r;
      return broadcastRoom(r);
    }
    if (!room) return;
    const me = room.players.findIndex(p => p.ws === ws);
    if (me < 0) return;

    if (m.t === 'ready' && (room.phase === 'lobby' || room.phase === 'over')) {
      room.players[me].ready = true;
      broadcastRoom(room);
      if (room.players.length === 2 && room.players.every(p => p.ready))
        room.mode === 'campaign' ? startCampaign(room) : startBattle(room);
      return;
    }

    if (room.phase === 'campaign' && room.campPhase === 'orders') {
      const c = room.camp;
      if (c.ready[me]) return;
      if (m.t === 'recruit') { if (C.recruit(c, me, m.prov | 0, String(m.type))) sendCamp(room); }
      else if (m.t === 'cmove') { if (C.setMove(c, me, m.army | 0, m.to === null ? null : m.to | 0)) sendCamp(room); }
      else if (m.t === 'endturn') {
        c.ready[me] = true; sendCamp(room);
        if (c.ready[0] && c.ready[1]) resolveTurn(room);
      }
      return;
    }

    if (room.phase !== 'battle') return;
    const ids = Array.isArray(m.ids) ? m.ids.filter(Number.isInteger).slice(0, 20) : [];
    if (m.t === 'move') giveOrder(room.battle, me, ids, { t: 'move', x: +m.x, y: +m.y });
    else if (m.t === 'attack') giveOrder(room.battle, me, ids, { t: 'attack', target: m.target | 0 });
    else if (m.t === 'stop') giveOrder(room.battle, me, ids, { t: 'stop' });
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Legio Online listening on http://localhost:${PORT}`));
