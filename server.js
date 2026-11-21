// Legio Online server: static files, lobby, live battles and campaigns on one port.
//
// Room state machine (all rooms live in memory, one object per room):
//   phase      lobby -> battle | campaign -> over -> (both ready) -> ...
//              campaign rooms cycle campaign -> battle -> between -> campaign until the campaign is over
//   campPhase  orders | resolving | battle | over   (null outside a campaign)
//   seats      [seat, seat?], index = side. A human seat without a socket is "lost" and held for a
//              grace period; when that runs out the seat is removed (a forfeit in a running game).
//   paused     true while any human seat is lost and for resumeDelayMs after the last one came back:
//              no sim steps, no snapshots, no hurry-up expiry. Other timers still do their work.
//   gen        bumped when a game starts, the room resets to the lobby, or the room is destroyed.
//              Every game timer captures gen and does nothing if it changed (see later()).
// Seat timers (grace) and the resume timer outlive games on purpose; they are guarded by their own
// identity instead of gen, and cleared when the seat or room goes away.
// In a running game grace is an allowance per seat, not a fresh graceMs per drop: time away is spent
// from it and it refills slowly while connected, so nobody can freeze a game for ever by dropping
// again and again. Outside a game (lobby, result screen) nobody is kept waiting: every drop gets graceMs.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { createBattle, giveOrder, step, snapshot, battleSurvivors, TYPES, W, H, BATTLE_TIME_LIMIT } from './sim.js';
import { botThink } from './bot.js';
import * as C from './campaign.js';
import { createHttpHandler } from './lib/http.js';
import { createTokenBucket, clientIp, createIpCounter } from './lib/limits.js';
import { MAX_FRAME, parseFrame, cleanName, cleanCode, battleOrders, campaignOrder, numberOption } from './lib/server-input.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_NAME = 'Rival Legate (AI)';
const SIDE = ['Red', 'Blue'];
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RUNNING = new Set(['battle', 'campaign', 'between']);
const MAX_DROPPED = 200;              // rate-limited messages before the connection is closed
const RATE_WARN_MS = 2000;            // at most one 'rate' error per connection in this window
const SNAP_SKIP_BYTES = 64 * 1024;    // a client this far behind gets no more snapshots for now
const MAX_BUFFERED = 1024 * 1024;     // a client this far behind has stopped reading: drop it
const CLOSE_WAIT_MS = 500;            // shutdown: time for close handshakes before sockets are cut
const OVERRUN_S = 5;                  // a battle this far past its limit is a sim fault
const MAX_TIMER_MS = 2 ** 31 - 1;     // setTimeout fires at once for anything longer
const REFUSE_LINGER_MS = 1000;        // a refused connection that does not close by itself is cut after this

const ERRORS = {
  badRoom: { t: 'error', code: 'bad_room', msg: 'Room not found or full.' },
  full: { t: 'error', code: 'server_full', msg: 'The server is full. Try again in a few minutes.' },
  rejoin: { t: 'error', code: 'rejoin_failed', msg: 'That game is no longer available.' },
  rate: { t: 'error', code: 'rate', msg: 'Too many messages. Slow down.' },
  shutdown: { t: 'error', code: 'shutdown', msg: 'The server is restarting. Reload in a minute.' },
};

const noop = () => {};

function readOptions(o) {
  const num = (key, fallback, min) => numberOption(o[key], fallback, min);
  const ms = (key, fallback, min) => Math.min(MAX_TIMER_MS, num(key, fallback, min));
  const rate = o.rate !== null && typeof o.rate === 'object' ? o.rate : {};
  return {
    tickMs: ms('tickMs', 50, 1),
    stepsPerTick: Math.min(1000, Math.floor(num('stepsPerTick', 1, 1))),   // extension for fast tests: sim steps per timer tick
    battleTimeLimit: num('battleTimeLimit', BATTLE_TIME_LIMIT, 0),
    betweenMs: ms('betweenMs', 3500),
    resolveDelayMs: ms('resolveDelayMs', 1200),
    graceMs: ms('graceMs', 60000),
    graceRefill: Math.min(1000, num('graceRefill', 0.25)),   // extension: grace earned back per ms connected (60 s in 4 min)
    resumeDelayMs: ms('resumeDelayMs', 1500),
    hurryMs: ms('hurryMs', 90000),
    heartbeatMs: ms('heartbeatMs', 25000, 1),
    idleRoomMs: ms('idleRoomMs', 45 * 60000, 1),
    maxRooms: Math.min(100000, num('maxRooms', 200)),      // far below the 36^4 codes, so newCode() ends
    maxConnections: num('maxConnections', 500),
    maxPerIp: num('maxPerIp', 20),
    rate: { capacity: numberOption(rate.capacity, 60), refillPerSec: numberOption(rate.refillPerSec, 30) },
    trustProxy: o.trustProxy === undefined ? !!process.env.RENDER : o.trustProxy,
    log: typeof o.log === 'function' ? o.log : console.log,
    publicDir: typeof o.publicDir === 'string' && o.publicDir ? o.publicDir : path.join(HERE, 'public'),
  };
}

export function createGameServer(options = {}) {
  const cfg = readOptions(options !== null && typeof options === 'object' ? options : {});
  const rooms = new Map();            // code -> room
  const conns = new Set();            // accepted sockets
  const ips = createIpCounter(cfg.maxPerIp);
  let loops = [];                     // server-wide intervals: battle ticks, heartbeat, idle sweep
  let stopped = false;
  let closing = null;                 // the promise of the one shutdown
  const logBudget = createTokenBucket(30, 1);

  const stats = () => ({ rooms: rooms.size, connections: conns.size });
  const httpServer = http.createServer(createHttpHandler({ publicDir: cfg.publicDir, getStats: stats }));
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME, closeTimeout: 5000 });
  wss.on('error', err => report('server error', err));
  wss.on('connection', (ws, req) => {
    try { onConnection(ws, req); } catch (err) { report('connection handler', err); ws.terminate(); }
  });

  // ---------- plumbing ----------

  // Errors are logged with a budget (a burst of 30, then one a second): a fault that repeats on
  // every message or tick must not turn into a flood of stack traces.
  function report(what, err) {
    if (!logBudget.take()) return;
    try { cfg.log(`[legio] ${what}: ${err instanceof Error ? err.stack : String(err)}`); } catch { /* a broken logger must not matter */ }
  }

  function sendText(ws, text) {
    if (!ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate();
    try { ws.send(text); } catch { /* the socket died between the check and the write */ }
  }
  const send = (ws, obj) => sendText(ws, JSON.stringify(obj));
  const broadcast = (room, obj) => { const text = JSON.stringify(obj); for (const s of room.seats) sendText(s.ws, text); };

  // Run fn after ms unless the room's game changed in the meantime (generation guard).
  function later(room, ms, fn) {
    const gen = room.gen;
    const timer = setTimeout(() => {
      room.timers.delete(timer);
      if (room.dead || room.gen !== gen) return;
      guard(room, fn);
    }, ms);
    room.timers.add(timer);
    return timer;
  }
  function cancel(room, timer) {
    if (timer) { clearTimeout(timer); room.timers.delete(timer); }
  }
  // The game this room was running (if any) is over for every pending timer.
  function bumpGen(room) {
    room.gen++;
    for (const timer of room.timers) clearTimeout(timer);
    room.timers.clear();
    room.hurry = null;
  }

  function guard(room, fn) {
    try { fn(); } catch (err) { fault(room, err); }
  }
  // Something threw inside this room. Log once per game, end the game as a draw, keep serving.
  function fault(room, err) {
    if (room.faults++ === 0) report('room fault, game ended as a draw', err);
    try { abortGame(room); } catch (err2) {
      report('room could not be recovered, closing it', err2);
      try { destroyRoom(room, 'closed'); } catch { /* nothing left to try */ }
    }
  }

  // ---------- rooms and seats ----------

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(code)) return code;
    }
  }
  function newRoom(mode) {
    const room = {
      code: newCode(), mode, phase: 'lobby', seats: [], gen: 0, dead: false, timers: new Set(), faults: 0,
      battle: null, camp: null, campPhase: null, queue: [], fight: null, hurry: null,
      paused: false, pauseSeq: 0, resumeTimer: null, lastActive: Date.now(),
    };
    rooms.set(room.code, room);
    return room;
  }
  // grace = ms of absence the seat may still use during games; lostAt / backAt = when its socket
  // went / came; hold = how long the current absence may last; spends = it counts against grace.
  const humanSeat = (ws, name) => ({
    name, token: crypto.randomBytes(18).toString('base64url'), ws, ready: false, bot: false,
    lostAt: 0, backAt: Date.now(), grace: cfg.graceMs, hold: 0, spends: false, graceTimer: null, owedEnd: false,
  });
  const botSeat = () => ({
    name: BOT_NAME, token: null, ws: null, ready: true, bot: true,
    lostAt: 0, backAt: 0, grace: 0, hold: 0, spends: false, graceTimer: null, owedEnd: false,
  });

  const isLost = seat => !seat.bot && !seat.ws;
  const anyLost = room => room.seats.some(isLost);
  const graceLeft = seat => Math.max(0, Math.ceil((seat.lostAt + seat.hold - Date.now()) / 1000));

  function attach(room, seat, ws) {
    seat.ws = ws; ws.room = room; ws.seat = seat;
    room.lastActive = Date.now();
  }
  function unseat(ws) { ws.room = null; ws.seat = null; }

  function roomView(room, i) {
    const players = room.seats.map(s => {
      const p = { name: s.name, ready: s.ready, bot: s.bot, connected: !isLost(s) };
      if (!p.connected) p.grace = graceLeft(s);
      return p;
    });
    return { t: 'room', code: room.code, phase: room.phase, mode: room.mode, you: i, token: room.seats[i].token, players };
  }
  function broadcastRoom(room) {
    room.seats.forEach((s, i) => { if (s.ws) send(s.ws, roomView(room, i)); });
  }

  function clearGame(room) {
    room.battle = null; room.camp = null; room.campPhase = null; room.queue = []; room.fight = null;
  }

  // Pause bookkeeping. pauseSeq invalidates a pending resume when a seat drops again.
  function pause(room) {
    room.pauseSeq++;
    clearTimeout(room.resumeTimer); room.resumeTimer = null;
    if (room.paused) return;
    room.paused = true;
    freezeHurry(room);
    if (room.hurry && room.camp) sendCamp(room);   // the countdown is off while paused (deadline: null)
  }
  function unpause(room) {
    room.pauseSeq++;
    clearTimeout(room.resumeTimer); room.resumeTimer = null;
    if (!room.paused) return;
    room.paused = false;
    armHurry(room);
    if (room.hurry && room.camp) sendCamp(room);   // the countdown runs again: show what is left
  }
  function scheduleResume(room) {
    if (!room.paused || anyLost(room) || room.resumeTimer) return;
    const seq = room.pauseSeq;
    room.resumeTimer = setTimeout(() => {
      room.resumeTimer = null;
      if (room.dead || room.pauseSeq !== seq || anyLost(room)) return;
      guard(room, () => unpause(room));
    }, cfg.resumeDelayMs);
  }

  // The socket of a seat went away (any phase): hold the seat. In a running game for what is left
  // of its grace, otherwise for graceMs.
  function seatLost(room, seat) {
    const now = Date.now(), running = RUNNING.has(room.phase);
    seat.grace = Math.min(cfg.graceMs, seat.grace + Math.max(0, now - seat.backAt) * cfg.graceRefill);
    seat.hold = running ? seat.grace : cfg.graceMs;
    seat.spends = running;
    seat.ws = null; seat.lostAt = now;
    if (!running) seat.ready = false;
    pause(room);
    clearTimeout(seat.graceTimer);
    const timer = seat.graceTimer = setTimeout(() => {
      if (room.dead || seat.graceTimer !== timer) return;
      seat.graceTimer = null;
      guard(room, () => removeSeat(room, seat));
    }, seat.hold);
    for (const s of room.seats) if (s !== seat && s.ws) send(s.ws, { t: 'peer', state: 'lost', grace: graceLeft(seat) });
    broadcastRoom(room);
  }

  // State sync for one socket (SPEC 2.3): room, then camp, then start (+ one snapshot so a paused field shows).
  function syncSeat(room, seat) {
    const i = room.seats.indexOf(seat), ws = seat.ws;
    send(ws, roomView(room, i));
    if (seat.owedEnd) {   // the opponent forfeited while this seat was away
      seat.owedEnd = false;
      send(ws, { t: 'end', winner: i, reason: 'forfeit', forfeit: true });
    }
    if (room.camp) send(ws, campView(room, i));
    if (room.phase === 'battle' && room.battle) {
      send(ws, startMsg(room, i));
      send(ws, { t: 'snap', ...snapshot(room.battle) });
    }
  }

  // Grace expiry or explicit leave. In a running game this is a forfeit.
  function removeSeat(room, seat) {
    const idx = room.seats.indexOf(seat);
    if (idx < 0) return;
    clearTimeout(seat.graceTimer); seat.graceTimer = null;
    if (seat.ws) unseat(seat.ws);
    seat.ws = null;
    room.seats.splice(idx, 1);
    const stay = room.seats.find(s => !s.bot);
    if (!stay) return destroyRoom(room);
    if (RUNNING.has(room.phase)) {
      // The winner is named by the seat index they played under; the fresh 'room' follows.
      if (stay.ws) send(stay.ws, { t: 'end', winner: 1 - idx, reason: 'forfeit', forfeit: true });
      else stay.owedEnd = true;
    }
    if (room.phase === 'lobby') { if (!anyLost(room)) unpause(room); broadcastRoom(room); }
    else resetToLobby(room);
  }

  // Discard the game (if any); the humans that are left wait in the lobby from seat 0.
  function resetToLobby(room) {
    bumpGen(room);
    clearGame(room);
    room.faults = 0;
    room.seats = room.seats.filter(s => !s.bot);
    for (const s of room.seats) s.ready = false;
    room.phase = 'lobby';
    if (!anyLost(room)) unpause(room);
    broadcastRoom(room);
  }

  // reason set: connected players are told with 'left'. Lost seats simply fail their rejoin.
  function destroyRoom(room, reason) {
    if (room.dead) return;
    room.dead = true;
    bumpGen(room);
    clearTimeout(room.resumeTimer); room.resumeTimer = null;
    for (const s of room.seats) {
      clearTimeout(s.graceTimer); s.graceTimer = null;
      const ws = s.ws;
      s.ws = null;
      if (!ws) continue;
      unseat(ws);
      if (reason) send(ws, { t: 'left', reason });
    }
    room.seats = [];
    clearGame(room);
    rooms.delete(room.code);
  }

  // Recovery after a fault: whatever was running ends as a draw, the room stays usable.
  function abortGame(room) {
    if (room.dead) return;
    const wasBattle = room.phase === 'battle', wasRunning = RUNNING.has(room.phase);
    bumpGen(room);
    room.battle = null; room.fight = null; room.queue = [];
    for (const s of room.seats) s.ready = s.bot;
    if (!wasRunning) return broadcastRoom(room);
    if (wasBattle) broadcast(room, { t: 'end', winner: -1, reason: 'timeout' });
    room.phase = 'over';
    if (room.camp) {
      room.camp.winner = -1; room.campPhase = 'over';
      sendCamp(room);
    }
    broadcastRoom(room);
  }

  // ---------- lobby ----------

  // At capacity a room that nobody is connected to gives way to a new one. Without this, one
  // address could fill the server by creating rooms and hanging up (each is held for its grace).
  // Rooms without a running game go first, then the one whose players have been away longest.
  function evictAbandoned() {
    let pick = null, best = Infinity;
    for (const room of rooms.values()) {
      const humans = room.seats.filter(s => !s.bot);
      if (humans.some(s => s.ws)) continue;
      const since = Math.min(...humans.map(s => s.lostAt)) + (RUNNING.has(room.phase) ? cfg.graceMs : 0);
      if (!pick || since < best) { pick = room; best = since; }
    }
    if (pick) destroyRoom(pick);
    return !!pick;
  }

  function onCreate(ws, m, withBot) {
    if (ws.room) return;
    if (rooms.size >= cfg.maxRooms && !evictAbandoned()) return send(ws, ERRORS.full);
    const room = newRoom(m.mode === 'campaign' ? 'campaign' : 'battle');
    const seat = humanSeat(ws, cleanName(m.name));
    room.seats.push(seat);
    attach(room, seat, ws);
    if (withBot) room.seats.push(botSeat());
    broadcastRoom(room);
  }

  function onJoin(ws, m) {
    if (ws.room) return;
    const code = cleanCode(m.code);
    if (code === null) return;
    const room = rooms.get(code);
    if (!room || room.phase !== 'lobby' || room.seats.length >= 2) return send(ws, ERRORS.badRoom);
    const seat = humanSeat(ws, cleanName(m.name));
    room.seats.push(seat);
    attach(room, seat, ws);
    broadcastRoom(room);
  }

  function tokenMatches(seat, token) {
    if (seat.bot || typeof token !== 'string') return false;
    const a = Buffer.from(seat.token), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Every rejoin from an unseated socket gets an answer, so a client never waits on a stale seat.
  function onRejoin(ws, m) {
    if (ws.room) return;
    const room = rooms.get(cleanCode(m.code) || '');
    const seat = room && room.seats.find(s => tokenMatches(s, m.token));
    if (!seat) return send(ws, ERRORS.rejoin);
    const wasLost = !seat.ws;
    if (wasLost) seatBack(seat); else replaceSocket(seat);
    attach(room, seat, ws);
    guard(room, () => {
      syncSeat(room, seat);
      room.seats.forEach((s, i) => {
        if (s === seat || !s.ws) return;
        if (wasLost) send(s.ws, { t: 'peer', state: 'back' });
        send(s.ws, roomView(room, i));
      });
    });
    scheduleResume(room);   // also after a fault above: a room must never stay paused with everyone present
  }
  // The owner of a lost seat returned. A drop during a game is paid for from the seat's grace: the
  // time away plus the resume delay it causes, and nothing is earned back during that delay.
  // (Otherwise dropping for an instant, again and again, would freeze a game at no cost.)
  function seatBack(seat) {
    const now = Date.now();
    clearTimeout(seat.graceTimer); seat.graceTimer = null;
    if (seat.spends) seat.grace = Math.max(0, seat.grace - Math.max(0, now - seat.lostAt) - cfg.resumeDelayMs);
    seat.lostAt = 0; seat.backAt = seat.spends ? now + cfg.resumeDelayMs : now;
  }
  // An older live socket of the same seat is cut loose without the seat-lost path.
  function replaceSocket(seat) {
    const old = seat.ws;
    unseat(old);
    seat.ws = null;
    try { old.close(4000, 'Replaced by a newer connection'); } catch { /* already closing */ }
  }

  function onLeave(ws) {
    const { room, seat } = ws;
    if (room && seat) {
      unseat(ws);
      seat.ws = null;
      guard(room, () => removeSeat(room, seat));
    }
    send(ws, { t: 'left', reason: 'leave' });
  }

  function onReady(room, me) {
    if (room.phase !== 'lobby' && room.phase !== 'over') return;
    room.seats[me].ready = true;
    const go = room.seats.length === 2 && room.seats.every(s => s.ready) && !anyLost(room);
    if (go) startGame(room); else broadcastRoom(room);
  }

  function startGame(room) {
    bumpGen(room);
    clearGame(room);
    room.faults = 0;
    if (room.mode === 'campaign') {
      room.camp = C.newCampaign(); room.campPhase = 'orders'; room.phase = 'campaign';
    } else {
      room.battle = makeBattle(undefined, null); room.phase = 'battle';
    }
    broadcastRoom(room);
    if (room.camp) { botOrders(room); sendCamp(room); } else announceBattle(room);
  }

  // ---------- live battles ----------

  const makeBattle = (armies, defender) => createBattle(armies, { timeLimit: cfg.battleTimeLimit, defender });
  const battleLimit = battle => (Number.isFinite(battle.timeLimit) ? battle.timeLimit : cfg.battleTimeLimit);
  const startMsg = (room, i) => ({ t: 'start', you: i, W, H, types: TYPES, limit: battleLimit(room.battle) });
  // A battle that starts paused (a seat is away) comes with one snapshot, so that whoever is
  // present sees the armies while waiting instead of an empty field.
  function announceBattle(room) {
    const field = room.paused ? JSON.stringify({ t: 'snap', ...snapshot(room.battle) }) : null;
    room.seats.forEach((s, i) => {
      if (!s.ws) return;
      send(s.ws, startMsg(room, i));
      if (field) sendText(s.ws, field);
    });
  }

  function tickRoom(room) {
    const b = room.battle;
    if (room.phase !== 'battle' || !b || room.paused) return;
    for (let n = 0; n < cfg.stepsPerTick && !b.over; n++) {
      step(b);
      room.seats.forEach((s, i) => { if (s.bot) botThink(b, i); });
    }
    if (!b.over && b.time > battleLimit(b) + OVERRUN_S) throw new Error('battle ran past its time limit');
    const text = JSON.stringify({ t: 'snap', ...snapshot(b) });
    for (const s of room.seats) if (s.ws && s.ws.bufferedAmount < SNAP_SKIP_BYTES) sendText(s.ws, text);
    if (b.over) endBattle(room);
  }

  function endBattle(room) {
    const b = room.battle;
    const winner = b.winner === 0 || b.winner === 1 ? b.winner : -1;
    broadcast(room, { t: 'end', winner, reason: b.reason === 'timeout' ? 'timeout' : 'rout' });
    if (room.camp) {
      room.phase = 'between';
      later(room, cfg.betweenMs, () => afterCampaignBattle(room, winner));
      return;
    }
    room.battle = null;
    gameOver(room);
  }

  function gameOver(room) {
    room.phase = 'over';
    for (const s of room.seats) s.ready = s.bot;
    if (room.camp) { room.campPhase = 'over'; sendCamp(room); }
    broadcastRoom(room);
  }

  function onBattleOrder(room, me, m) {
    const b = room.battle;
    if (room.phase !== 'battle' || !b || b.over || room.paused) return;
    const orders = battleOrders(m, W, H);
    if (!orders) return;
    const mine = id => b.regs.some(r => r.id === id && r.owner === me);
    for (const o of orders) {
      const ids = o.ids.filter(mine);
      if (ids.length) giveOrder(b, me, ids, o.order);
    }
  }

  // ---------- campaign ----------

  // No deadline is shown while the room is paused: the countdown does not run then.
  function deadline(room) {
    const h = room.hurry;
    if (!h || room.paused) return null;
    const left = h.timer ? h.left - (Date.now() - h.since) : h.left;
    return { who: h.who, left: Math.max(0, Math.ceil(left / 1000)) };
  }

  // Each player gets only their own gold and pending marches.
  function campView(room, p) {
    const c = room.camp, other = room.seats[1 - p];
    return {
      t: 'camp', you: p, turn: c.turn, phase: room.campPhase, winner: c.winner,
      gold: c.gold[p], income: C.INCOME, units: C.totalUnits(c, p), maxUnits: C.MAX_UNITS, cost: C.COST, types: TYPES,
      replenish: C.REPLENISH,
      provs: C.PROVS, edges: C.EDGES, capital: C.CAPITAL, owner: c.owner,
      armies: c.armies.map(a => ({ id: a.id, owner: a.owner, prov: a.prov, units: a.units.map(u => ({ type: u.type, men: u.men })) })),
      moves: c.moves[p],
      ready: c.ready, log: c.log.slice(-8), opponent: other ? other.name : '',
      deadline: deadline(room),
    };
  }
  function sendCamp(room) {
    room.seats.forEach((s, i) => { if (s.ws) send(s.ws, campView(room, i)); });
  }

  function botOrders(room) {
    room.seats.forEach((s, i) => {
      if (!s.bot) return;
      C.aiTurn(room.camp, i);
      room.camp.ready[i] = true;
    });
  }

  function onCampaignOrder(room, me, m) {
    const c = room.camp;
    if (room.phase !== 'campaign' || room.campPhase !== 'orders' || !c || c.ready[me]) return;
    const o = campaignOrder(m);
    if (!o) return;
    if (o.t === 'endturn') return endTurnFor(room, me);
    const ok = o.t === 'recruit' ? C.recruit(c, me, o.prov, o.type) : C.setMove(c, me, o.army, o.to);
    if (ok) sendCamp(room);
  }

  function endTurnFor(room, who) {
    const c = room.camp;
    c.ready[who] = true;
    if (c.ready[0] && c.ready[1]) return resolveTurn(room);
    if (!room.seats[1 - who].bot) startHurry(room, 1 - who);
    sendCamp(room);
  }

  // Hurry-up: the slower human gets hurryMs, frozen while the room is paused.
  function startHurry(room, who) {
    clearHurry(room);
    room.hurry = { who, left: cfg.hurryMs, since: 0, timer: null };
    armHurry(room);
  }
  function armHurry(room) {
    const h = room.hurry;
    if (!h || h.timer || room.paused) return;
    h.since = Date.now();
    h.timer = later(room, h.left, () => {
      if (room.hurry !== h) return;
      h.timer = null; h.left = 0;
      if (!room.paused) expireHurry(room);   // paused: unpause() re-arms it with nothing left
    });
  }
  function freezeHurry(room) {
    const h = room.hurry;
    if (!h || !h.timer) return;
    cancel(room, h.timer); h.timer = null;
    h.left = Math.max(0, h.left - (Date.now() - h.since));
  }
  function clearHurry(room) {
    if (room.hurry) cancel(room, room.hurry.timer);
    room.hurry = null;
  }
  function expireHurry(room) {
    const who = room.hurry.who, c = room.camp;
    room.hurry = null;
    if (room.campPhase !== 'orders' || !c || c.ready[who]) return;
    c.log.push(`${SIDE[who]} ran out of time.`);
    endTurnFor(room, who);
  }

  function resolveTurn(room) {
    clearHurry(room);
    room.campPhase = 'resolving';
    room.queue = C.resolveMoves(room.camp);
    sendCamp(room);
    later(room, cfg.resolveDelayMs, () => nextBattle(room));
  }

  // Fight the queued battles one at a time, then finish the turn.
  function nextBattle(room) {
    const c = room.camp;
    for (;;) {
      const b = room.queue.shift();
      if (!b) return finishTurn(room);
      const a0 = c.armies.find(a => a.id === b.a0), a1 = c.armies.find(a => a.id === b.a1);
      if (!a0 || !a1) continue;   // an army that no longer exists cannot fight
      const units = a => a.units.map(u => ({ type: u.type, men: u.men }));
      room.fight = b;
      room.battle = makeBattle([units(a0), units(a1)], b.defender === 0 || b.defender === 1 ? b.defender : null);
      room.campPhase = 'battle'; room.phase = 'battle';
      c.log.push(`Armies clash at ${C.PROVS[b.prov].name}!`);
      sendCamp(room);
      return announceBattle(room);
    }
  }

  function afterCampaignBattle(room, winner) {
    const bat = room.battle, fight = room.fight;
    room.battle = null; room.fight = null;
    const applied = C.applyBattle(room.camp, fight, winner, [battleSurvivors(bat, 0), battleSurvivors(bat, 1)]);
    // A refused result would leave both armies in one province and the same battle would recur forever.
    if (applied === false) throw new Error('campaign refused a battle result');
    nextBattle(room);
  }

  function finishTurn(room) {
    const c = room.camp;
    // A refused step would leave the turn half-finished with both players marked ready: fail loudly instead.
    if (C.settle(c) === false) throw new Error('campaign refused to settle the turn');
    if (c.winner !== null) return gameOver(room);
    if (C.endTurn(c) === false) throw new Error('campaign refused to end the turn');
    room.campPhase = 'orders'; room.phase = 'campaign';
    botOrders(room);
    sendCamp(room);
  }

  // ---------- connections ----------

  // Over a limit: say so with close code 1013, and do not wait long for the other side to hang up.
  function refuse(ws) {
    ws.close(1013, 'Server busy');
    const timer = setTimeout(() => ws.terminate(), REFUSE_LINGER_MS);
    timer.unref();
    ws.once('close', () => clearTimeout(timer));
  }

  function onConnection(ws, req) {
    ws.on('error', noop);   // protocol errors (oversized frame, bad UTF-8) close the socket by themselves
    const ip = clientIp(req, cfg.trustProxy);
    if (stopped || conns.size >= cfg.maxConnections || !ips.add(ip)) return refuse(ws);
    conns.add(ws);
    ws.ip = ip; ws.room = null; ws.seat = null; ws.alive = true; ws.dropped = 0; ws.warnedAt = 0;
    ws.bucket = createTokenBucket(cfg.rate.capacity, cfg.rate.refillPerSec);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data, isBinary) => {
      try { onMessage(ws, data, isBinary); } catch (err) { report('message handler', err); }
    });
    ws.on('close', () => {
      try { onClose(ws); } catch (err) { report('close handler', err); }
    });
  }

  function onClose(ws) {
    if (!conns.delete(ws)) return;
    ips.remove(ws.ip);
    const { room, seat } = ws;
    unseat(ws);
    if (stopped || !room || room.dead || !seat || seat.ws !== ws) return;
    guard(room, () => seatLost(room, seat));
  }

  function overBudget(ws) {
    if (++ws.dropped > MAX_DROPPED) return ws.close(1008, 'Too many messages');
    const now = Date.now();
    if (now - ws.warnedAt < RATE_WARN_MS) return;
    ws.warnedAt = now;
    send(ws, ERRORS.rate);
  }

  function onMessage(ws, data, isBinary) {
    if (ws.readyState !== 1) return;
    if (!ws.bucket.take()) return overBudget(ws);
    const m = parseFrame(data, isBinary);
    if (!m) return;
    if (m.t === 'ping') return send(ws, { t: 'pong', n: Number.isFinite(m.n) ? m.n : undefined });
    if (ws.room) ws.room.lastActive = Date.now();
    switch (m.t) {
      case 'create': return onCreate(ws, m, false);
      case 'practice': return onCreate(ws, m, true);
      case 'join': return onJoin(ws, m);
      case 'rejoin': return onRejoin(ws, m);
      case 'leave': return onLeave(ws);
    }
    const room = ws.room;
    if (!room) return;
    const me = room.seats.indexOf(ws.seat);
    if (me >= 0) guard(room, () => onRoomMessage(room, me, m));
  }

  function onRoomMessage(room, me, m) {
    switch (m.t) {
      case 'ready': return onReady(room, me);
      case 'recruit': case 'cmove': case 'endturn': return onCampaignOrder(room, me, m);
      case 'move': case 'moves': case 'attack': case 'stop': return onBattleOrder(room, me, m);
    }
  }

  // ---------- server-wide loops ----------

  function tickAll() {
    for (const room of rooms.values()) guard(room, () => tickRoom(room));
  }
  // A socket that did not answer the previous ping is dead; terminating it runs the seat-lost path.
  function heartbeat() {
    for (const ws of conns) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }
  function sweepIdle() {
    const cutoff = Date.now() - cfg.idleRoomMs;
    for (const room of rooms.values()) if (room.lastActive < cutoff) destroyRoom(room, 'idle');
  }
  const safely = (what, fn) => () => { try { fn(); } catch (err) { report(what, err); } };

  function startLoops() {
    if (stopped || loops.length) return;
    const sweepMs = Math.max(10, Math.min(30000, cfg.idleRoomMs / 4));
    loops = [
      setInterval(safely('battle tick', tickAll), cfg.tickMs),
      setInterval(safely('heartbeat', heartbeat), cfg.heartbeatMs),
      setInterval(safely('idle sweep', sweepIdle), sweepMs),
    ];
  }

  function listen(port = 0, host) {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        startLoops();
        resolve(httpServer.address().port);
      });
    });
  }

  // Resolves when every socket closed, or after ms.
  function socketsClosed(socks, ms) {
    return new Promise(resolve => {
      let open = socks.filter(ws => ws.readyState !== 3);
      if (!open.length) return resolve();
      const timer = setTimeout(resolve, ms);
      const check = () => {
        open = open.filter(ws => ws.readyState !== 3);
        if (!open.length) { clearTimeout(timer); resolve(); }
      };
      for (const ws of open) ws.once('close', check);
    });
  }

  async function shutdown() {
    stopped = true;
    for (const timer of loops) clearInterval(timer);
    loops = [];
    for (const room of [...rooms.values()]) destroyRoom(room);
    const socks = [...wss.clients];
    for (const ws of socks) {
      send(ws, ERRORS.shutdown);
      try { ws.close(1001, 'Server restarting'); } catch { /* already closing */ }
    }
    wss.close();
    await socketsClosed(socks, CLOSE_WAIT_MS);
    for (const ws of socks) if (ws.readyState !== 3) ws.terminate();
    await new Promise(resolve => {
      httpServer.close(() => resolve());   // also fine when it never listened
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
    });
  }
  function close() {
    if (!closing) closing = shutdown();
    return closing;
  }

  // _rooms is for the test suite only (fault injection); nothing remote can reach it.
  return { httpServer, listen, close, stats, _rooms: rooms };
}

// ---------- run directly: node server.js ----------

function isMain() {
  if (!process.argv[1]) return false;
  const urls = [pathToFileURL(process.argv[1]).href];
  try { urls.push(pathToFileURL(fs.realpathSync(process.argv[1])).href); } catch { /* not a real file */ }
  return urls.includes(import.meta.url);
}

// TRUST_PROXY overrides which X-Forwarded-For hop is believed: 'false', 'true' (first hop, the
// default on Render) or N = the Nth hop from the right, for N proxies of our own in front.
function trustProxyFromEnv() {
  const v = String(process.env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (v === 'true' || v === 'false') return v === 'true';
  return /^[0-9]{1,2}$/.test(v) ? Number(v) : undefined;
}

function main() {
  const game = createGameServer({ trustProxy: trustProxyFromEnv() });
  // Last line of defence: log and keep serving the other rooms.
  process.on('uncaughtException', err => console.error('[legio] uncaught exception:', err));
  process.on('unhandledRejection', err => console.error('[legio] unhandled rejection:', err));
  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    console.log(`[legio] ${signal}: shutting down`);
    setTimeout(() => process.exit(0), 3000).unref();   // hard deadline (SPEC 7.2)
    game.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  const port = Number(process.env.PORT) || 3000;
  game.listen(port).then(
    bound => console.log(`Legio Online listening on http://localhost:${bound}`),
    err => { console.error('[legio] could not listen:', err); process.exit(1); },
  );
}

if (isMain()) main();
