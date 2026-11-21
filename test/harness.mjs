// Shared helpers for the server end-to-end tests: an in-process game server on
// a random port with fast timers, and a WebSocket client whose messages can be
// awaited in order.
import nodeTest from 'node:test';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.js';

// node:test with a deadline on every test: a wait that never settles fails that test
// instead of hanging the whole suite.
export const test = (name, fn) => nodeTest(name, { timeout: 60000 }, fn);

// Timers are tiny, and several sim steps run per timer tick, because OS timers
// can be as coarse as ~15 ms (Windows): a 300 s battle must not take minutes.
// The message budget is wide open: test clients order far faster than people do.
export const FAST = {
  tickMs: 2, stepsPerTick: 10, betweenMs: 20, resolveDelayMs: 10, graceMs: 400, resumeDelayMs: 20,
  hurryMs: 60000, heartbeatMs: 60000, rate: { capacity: 1e6, refillPerSec: 1e6 }, log: () => {},
};

export async function startTestServer(options = {}) {
  const game = createGameServer({ ...FAST, ...options });
  const port = await game.listen(0, '127.0.0.1');
  return {
    port, game,
    wsUrl: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    close: () => game.close(),
  };
}

const describe = m => (m && typeof m === 'object' ? m.t + (m.code && m.t === 'error' ? `:${m.code}` : '') : String(m));

// Resolves with a client once the socket is open (rejects if it never opens). wsOptions go to the ws client.
export function connect(wsUrl, wsOptions = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, wsOptions);
    const msgs = [];      // every message received, in order
    let cursor = 0;       // next() has consumed msgs[0 .. cursor)
    let waiter = null;    // { predicate, resolve, reject, timer }
    let closeInfo = null;
    let opened = false;

    // Hand the first unconsumed match to the waiter; everything before it is consumed too.
    function pump() {
      if (!waiter) return;
      for (let i = cursor; i < msgs.length; i++) {
        if (!waiter.predicate(msgs[i])) continue;
        cursor = i + 1;
        const w = waiter; waiter = null;
        clearTimeout(w.timer);
        return w.resolve(msgs[i]);
      }
      cursor = msgs.length;
      if (!closeInfo) return;
      const w = waiter; waiter = null;
      clearTimeout(w.timer);
      w.reject(new Error(`socket closed (${closeInfo.code}) while waiting for ${w.what}`));
    }

    const closed = new Promise(done => {
      ws.on('close', (code, reason) => {
        closeInfo = { code, reason: reason.toString() };
        done(closeInfo);
        pump();
        if (!opened) reject(new Error(`socket closed (${code}) before it opened`));
      });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try { msgs.push(JSON.parse(data.toString())); } catch { msgs.push({ t: '#unparsable', raw: data.toString() }); }
      pump();
    });
    ws.on('error', err => { if (!opened) reject(err); });   // after the open, 'close' tells the story

    const client = {
      ws, msgs, closed,
      send: obj => ws.send(JSON.stringify(obj)),
      sendRaw: text => ws.send(text),
      // First not-yet-consumed message matching predicate (a function or a 't' string).
      next(predicate = () => true, timeoutMs = 5000) {
        const what = typeof predicate === 'string' ? `'${predicate}'` : (predicate.name || 'a message');
        const match = typeof predicate === 'string' ? m => m.t === predicate : predicate;
        if (waiter) return Promise.reject(new Error('next() called while another next() is pending'));
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            waiter = null;
            const tail = msgs.slice(-6).map(describe).join(', ');
            rej(new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last messages: [${tail}]`));
          }, timeoutMs);
          waiter = { predicate: match, resolve: res, reject: rej, timer, what };
          pump();
        });
      },
      // Messages that arrived but were not consumed by next() yet.
      pending: () => msgs.slice(cursor),
      // Round trip: when it resolves, the server has processed everything this client sent, and
      // everything the server sent before its pong has arrived. Consumes nothing.
      flush() {
        const n = Math.floor(Math.random() * 1e9);
        client.send({ t: 'ping', n });
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { ws.off('message', check); rej(new Error('flush timed out')); }, 5000);
          function check() {
            if (!msgs.some(m => m.t === 'pong' && m.n === n)) return;
            clearTimeout(timer); ws.off('message', check); res();
          }
          ws.on('message', check);
        });
      },
      close() {
        if (ws.readyState === WebSocket.CLOSED) return closed;
        ws.close();
        return closed;
      },
      terminate() { ws.terminate(); return closed; },
    };
    ws.on('open', () => { opened = true; resolve(client); });
  });
}

// ---- small scenario helpers used by several test files ----

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Two humans in one lobby: {a, b, code, roomA, roomB}, a in seat 0. roomA / roomB hold the seat tokens.
export async function pair(server, mode = 'battle') {
  const a = await connect(server.wsUrl), b = await connect(server.wsUrl);
  a.send({ t: 'create', name: 'Ann', mode });
  const first = await a.next('room');
  b.send({ t: 'join', code: first.code, name: 'Bob' });
  const roomB = await b.next('room');
  const roomA = await a.next(m => m.t === 'room' && m.players.length === 2);
  return { a, b, code: first.code, roomA, roomB };
}

// Both ready up; resolves when each client has seen what the game opens with.
export async function readyBoth(a, b, opening) {
  a.send({ t: 'ready' }); b.send({ t: 'ready' });
  return Promise.all([a.next(opening), b.next(opening)]);
}

// Regiment rows of a snapshot: [id, owner, type, x, y, face, men, morale, state, ammo, engagedId].
export const alive = r => r[8] !== 'dead' && r[8] !== 'rout';
export function nearestFoe(r, regs) {
  let best = null, bd = Infinity;
  for (const f of regs) {
    if (f[1] === r[1] || !alive(f)) continue;
    const d = Math.hypot(f[3] - r[3], f[4] - r[4]);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
// Every live regiment of `side` attacks its nearest live enemy (one frame per target).
export function attackNearest(client, side, snap) {
  const byTarget = new Map();
  for (const r of snap.regs) {
    if (r[1] !== side || !alive(r)) continue;
    const foe = nearestFoe(r, snap.regs);
    if (!foe) continue;
    if (!byTarget.has(foe[0])) byTarget.set(foe[0], []);
    byTarget.get(foe[0]).push(r[0]);
  }
  for (const [target, ids] of byTarget) client.send({ t: 'attack', ids, target });
}

// ---- campaign helpers (two humans; army 1 belongs to seat 0, army 2 to seat 1) ----

const campIn = phase => m => m.t === 'camp' && m.phase === phase;

// Both players order one march each (undefined = stand still) and end the turn. Resolves with
// [viewA, viewB]: the 'resolving' views when a battle is expected, else the next 'orders' views.
export async function campTurn(a, b, toA, toB, { battle = false } = {}) {
  if (toA !== undefined) a.send({ t: 'cmove', army: 1, to: toA });
  if (toB !== undefined) b.send({ t: 'cmove', army: 2, to: toB });
  a.send({ t: 'endturn' });
  b.send({ t: 'endturn' });
  const resolving = await Promise.all([a.next(campIn('resolving')), b.next(campIn('resolving'))]);
  if (battle) return resolving;
  return Promise.all([a.next(campIn('orders')), b.next(campIn('orders'))]);
}

// March the starting armies along 0-2-4-6 and 12-10-7 and then into province `at` (6 or 7), where
// they must fight. Resolves with the 'resolving' views of the turn in which they meet.
//   at 6: both walk in, the province is neutral, nobody defends
//   at 7: seat 1 already holds it (taken the turn before), seat 0 attacks, seat 1 defends
export async function marchToBattle(a, b, at = 6) {
  await campTurn(a, b, 2, 10);
  await campTurn(a, b, 4, 7);
  if (at === 6) return campTurn(a, b, 6, 6, { battle: true });
  await campTurn(a, b, 6, undefined);
  return campTurn(a, b, 7, undefined, { battle: true });
}
