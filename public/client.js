'use strict';
// Legio Online browser client: connection manager, screens, battle view.
// Classic script, loaded before campaign.js. All state lives in one closure so that nothing
// can collide with campaign.js; the only globals are the names of the shared contract
// (SPEC 8.1): $, send, leaveRoom, escapeHtml, showEndOverlay, mySeat.

function $(id) { return document.getElementById(id); }

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, ch => map[ch]);
}

var LegioClient = (function () {
  // ---------- constants ----------
  const SEAT_KEY = 'legio.seat', NAME_KEY = 'legio.name';
  const RETRY_MS = [1000, 2000, 3000];      // then every 3 s
  const GIVE_UP_MS = 75000;                 // total time we keep retrying
  const ATTEMPT_MS = 20000;                 // a handshake that hangs this long is abandoned
  const WAKE_NOTE_MS = 3000;
  const PING_MS = 20000, HEALTH_MS = 240000;
  const REJOIN_WAIT_MS = 8000, LEAVE_WAIT_MS = 3000, SHUTDOWN_WAIT_MS = 5000;
  const HUD_SPACE = 52;                     // px kept free above the field for the HUD
  const HIT_RADIUS = 28, LINE_DRAG_MIN = 30, FIELD_MARGIN = 10;
  const FAR = 100000, MAX_MEN = 9999, MAX_DOTS = 120;   // sanity caps for numbers from the wire
  const MAX_ORDER_UNITS = 20;
  const STALL_MS = 300, PAUSE_NOTE_MS = 800, MAX_HELD = 12;   // see order(): the server drops orders while paused
  const COL = [['#b3262a', '#e8c15a'], ['#2a4f9b', '#d9d2c0']];
  const SIDE_TEXT = [['Red (left)', '#ff8a80'], ['Blue (right)', '#8ab4ff']];
  const TYPE_KEYS = ['sword', 'spear', 'archer', 'cav'];   // keys 1-4
  const GLYPH = { sword: '\u2694', spear: '\u2020', archer: '\u27B6', cav: '\u265E' };

  // ---------- small helpers ----------
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const r1 = n => Math.round(n * 10) / 10;
  const ticks = () => (typeof performance === 'object' && performance && performance.now ? performance.now() : Date.now());

  function show(id, on, mode) {
    const el = $(id);
    if (el) el.style.display = on ? (mode || 'block') : 'none';
  }
  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }
  function listen(target, type, fn) {
    const el = typeof target === 'string' ? $(target) : target;
    if (el && el.addEventListener) el.addEventListener(type, fn);
  }
  function make(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function stored(area, key) {
    try { return window[area].getItem(key); } catch (e) { return null; }
  }
  function store(area, key, value) {
    try {
      if (value === null) window[area].removeItem(key); else window[area].setItem(key, value);
    } catch (e) { /* storage disabled: we simply cannot survive a reload */ }
  }

  // ---------- state ----------
  let me = 0;                 // my seat index
  let seat = loadSeat();      // {code, token} to rejoin with, or null
  let room = null;            // last `room` message while seated
  let screen = 'menu';        // menu | room | camp | battle
  let campSeen = false;       // a campaign view arrived for the current game
  let rejoining = false, rejoinTimer = 0;
  let leaving = null, leaveTimer = 0;       // {code} between sending `leave` and the reply
  let endShown = false, endLeave = false;
  let helpOpen = false;
  let flashText = '', flashTimer = 0;
  let loopOn = false, drawFailed = false;

  const conn = { ws: null, state: 'connecting', everOpen: false, attempt: 0, lostAt: 0, waking: false,
    full: false, notice: '', lastRx: 0, pingAt: 0, retryTimer: 0, giveUpTimer: 0, attemptTimer: 0, noticeTimer: 0 };
  const peer = { lost: false, until: 0, timer: 0 };
  const battle = { live: false, W: 1600, H: 900, types: {}, limit: 0, time: 0, left: null,
    regs: [], byId: new Map(), prevById: new Map(), snapAt: 0, prevAt: 0, startMen: new Map(),
    simAt: 0, moving: false, held: [], pauseNote: false };
  const selected = new Set();
  const view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  const pointer = { x: 0, y: 0, box: null, line: null };
  const cardEls = new Map();  // regiment id -> {el, men, bar, key}
  let fx = [];                // short-lived order markers

  function loadSeat() {
    try {
      const s = JSON.parse(stored('sessionStorage', SEAT_KEY) || 'null');
      const ok = s && typeof s.code === 'string' && /^[A-Za-z0-9]{4}$/.test(s.code) &&
        typeof s.token === 'string' && s.token.length > 0 && s.token.length <= 256;
      return ok ? { code: s.code, token: s.token } : null;
    } catch (e) { return null; }
  }
  function saveSeat(s) {
    seat = s;
    store('sessionStorage', SEAT_KEY, s ? JSON.stringify(s) : null);
  }

  // ---------- campaign.js hooks (guarded: a load problem there must not break battles) ----------
  function callRenderCamp(m) {
    try { if (typeof renderCamp === 'function') renderCamp(m); } catch (e) { console.error(e); }
  }
  function callCampaignReset() {
    try { if (typeof campaignReset === 'function') campaignReset(); } catch (e) { console.error(e); }
  }

  // ---------- connection manager ----------
  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  }

  function send(obj) {
    const ws = conn.ws;
    if (!ws || conn.state !== 'open' || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function connect() {
    clearTimeout(conn.retryTimer);
    if (conn.ws || conn.state === 'open' || conn.state === 'dead') return;
    let sock = null;
    try { sock = new WebSocket(wsUrl()); } catch (e) { sock = null; }
    if (!sock) return onClosed(0);
    conn.ws = sock;
    // every callback checks it still belongs to the current socket
    sock.onopen = () => { if (sock === conn.ws) onOpen(); };
    sock.onmessage = e => { if (sock === conn.ws) onFrame(e.data); };
    sock.onclose = e => { if (sock === conn.ws) onClosed(e ? e.code : 0); };
    sock.onerror = () => {};
    clearTimeout(conn.attemptTimer);
    conn.attemptTimer = setTimeout(() => {
      if (sock === conn.ws && conn.state !== 'open') { dropSocket(); onClosed(0); }
    }, ATTEMPT_MS);
  }

  // Detach first, so the old socket's late events are ignored.
  function dropSocket() {
    const s = conn.ws;
    conn.ws = null;
    if (s) { try { s.close(); } catch (e) { /* already closed */ } }
  }

  function beginOutage() {
    if (conn.lostAt) return;
    conn.lostAt = Date.now();
    clearTimeout(conn.giveUpTimer);
    conn.giveUpTimer = setTimeout(giveUp, GIVE_UP_MS);
  }

  function onOpen() {
    conn.state = 'open'; conn.everOpen = true; conn.attempt = 0; conn.lostAt = 0;
    conn.waking = false; conn.full = false; conn.notice = '';
    conn.lastRx = Date.now(); conn.pingAt = 0;
    clearTimeout(conn.giveUpTimer); clearTimeout(conn.attemptTimer);
    if (seat) startRejoin();
    else if (room || screen !== 'menu') localLeave('The connection was lost and the game could not be resumed.');
    renderBanner(); renderMenu();
  }

  function onClosed(code) {
    conn.ws = null;
    clearTimeout(conn.attemptTimer); clearTimeout(conn.noticeTimer);
    endRejoin(); endLeaving();
    conn.notice = '';
    if (conn.state === 'dead') return;
    // 4000 = the server moved our seat to a newer socket (another tab): do not fight over it
    if (code === 4000 && (seat || room)) localLeave('This game was taken over by another tab or window.');
    conn.full = code === 1013;
    conn.state = conn.everOpen ? 'lost' : 'connecting';
    beginOutage();
    conn.retryTimer = setTimeout(connect, RETRY_MS[Math.min(conn.attempt, RETRY_MS.length - 1)]);
    conn.attempt++;
    cancelPointer();
    renderBanner(); renderMenu();
  }

  function giveUp() {
    if (conn.state === 'open' || conn.state === 'dead') return;
    conn.state = 'dead';
    clearTimeout(conn.retryTimer); clearTimeout(conn.attemptTimer);
    dropSocket();
    renderBanner(); renderMenu();
  }

  // The link looks dead (no answer to our ping, or a leave that got no reply): start over.
  function forceReconnect() {
    if (conn.state !== 'open') return;
    dropSocket();
    onClosed(0);
  }

  // The network or the tab came back: do not wait for the next retry timer.
  function nudge() {
    if (conn.state === 'open') return;
    if (conn.state === 'dead') {
      conn.state = conn.everOpen ? 'lost' : 'connecting';
      conn.attempt = 0; conn.lostAt = 0;
      beginOutage();
      renderBanner(); renderMenu();
    }
    connect();
  }

  function keepAlive() {
    if (conn.state !== 'open') return;
    // nothing at all arrived since the previous ping (the server answers every ping): dead link
    if (conn.pingAt && conn.lastRx < conn.pingAt) return forceReconnect();
    conn.pingAt = Date.now();
    send({ t: 'ping' });
  }

  // Free hosting sleeps without HTTP traffic, even while WebSockets are busy.
  function keepAwake() {
    if (!room || conn.state !== 'open' || typeof fetch !== 'function') return;
    try { fetch('/healthz', { cache: 'no-store' }).catch(() => {}); } catch (e) { /* not fatal */ }
  }

  function startRejoin() {
    rejoining = true;
    send({ t: 'rejoin', code: seat.code, token: seat.token });
    clearTimeout(rejoinTimer);
    rejoinTimer = setTimeout(() => { if (rejoining) rejoinFailed('That game is no longer available.'); }, REJOIN_WAIT_MS);
  }
  function endRejoin() {
    rejoining = false;
    clearTimeout(rejoinTimer);
  }
  function rejoinFailed(msg) {
    const quiet = !!leaving;    // the player already chose to leave: no need for a message
    endLeaving();
    localLeave(quiet ? '' : msg);
  }

  // ---------- incoming messages ----------
  function onFrame(data) {
    conn.lastRx = Date.now();
    if (typeof data !== 'string') return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { dispatch(m); } catch (e) { console.error(e); }
  }

  function dispatch(m) {
    switch (m.t) {
      case 'snap': return onSnap(m);
      case 'room': return onRoom(m);
      case 'start': return onStart(m);
      case 'end': return onEnd(m);
      case 'camp': return onCamp(m);
      case 'peer': return onPeer(m);
      case 'left': return onLeft(m);
      case 'error': return onError(m);
      default: return undefined;   // pong and anything unknown
    }
  }

  function onRoom(m) {
    if (typeof m.code !== 'string' || !Array.isArray(m.players)) return;
    if (leaving) {
      if (m.code === leaving.code) return;   // stale news about the room we are leaving
      endLeaving();
    }
    const resync = rejoining;
    endRejoin();
    if (!room || room.code !== m.code) forgetGame();
    room = m;
    me = m.you === 1 ? 1 : 0;
    if (typeof m.token === 'string' && m.token) saveSeat({ code: m.code, token: m.token });
    if (resync) battle.live = false;   // after a rejoin a running battle announces itself with `start`
    if (m.phase === 'lobby') campSeen = false;
    const idle = m.phase === 'lobby' || m.phase === 'over';
    // No game is running any more and no result is waiting to be acknowledged: we missed its end.
    if (idle && (screen === 'battle' || screen === 'camp') && !(endShown && endLeave)) backToRoom();
    else if (screen === 'menu') setScreen('room');
    renderRoom();
    syncPeer(m);
    renderBanner();
  }

  function onStart(m) {
    if (leaving) return;
    me = m.you === 1 ? 1 : 0;
    beginBattle(m);
    hideEnd();
    setScreen('battle');
    updateHud();
  }

  function onSnap(m) {
    if (!battle.live || leaving || !Array.isArray(m.regs)) return;
    const first = battle.regs.length === 0;
    battle.prevById = battle.byId; battle.prevAt = battle.snapAt;
    battle.byId = new Map(); battle.regs = [];
    for (const a of m.regs) {
      const r = parseReg(a);
      if (r && !battle.byId.has(r.id)) { battle.regs.push(r); battle.byId.set(r.id, r); }
    }
    battle.snapAt = ticks();
    noteSimTime(m.time, first);
    battle.left = isNum(m.left) ? clamp(Math.ceil(m.left), 0, 86400) : null;
    for (const r of battle.regs) if (!battle.startMen.has(r.id)) battle.startMen.set(r.id, r.men);
    if (first && battle.regs.length) { buildCards(); layout(); }
    pruneSelection();
    updateHud();
    updateCards();
  }

  // Sim time stands still while the server has the game paused (a seat is away, or just came back).
  function noteSimTime(time, first) {
    const advanced = !first && (!isNum(time) || time > battle.time);
    if (isNum(time)) battle.time = time;
    if (first) battle.simAt = ticks();
    if (!advanced) return;
    battle.simAt = ticks();
    battle.moving = true;
    const held = battle.held;
    battle.held = [];
    for (const o of held) send(o);   // orders given during the pause: the server ignored them then
  }

  function onEnd(m) {
    if (leaving || !room) return;
    const forfeit = m.reason === 'forfeit' || m.forfeit === true;
    const campaignBattle = inCampaign();
    battle.live = false;
    battle.held = [];
    cancelPointer();
    selected.clear();
    updateCards();
    // only the player who stayed is told about a forfeit, so that is always a win
    const won = forfeit || m.winner === me, draw = !won && m.winner === -1;
    const title = won ? 'VICTORY' : draw ? 'DRAW' : 'DEFEAT';
    let sub = won ? 'The enemy army broke' : draw ? 'Both armies broke' : 'Your army broke';
    if (forfeit) sub = 'Your opponent left';
    else if (m.reason === 'timeout') sub = 'Time expired';
    const leave = forfeit || !campaignBattle;
    showEndOverlay(title, leave ? sub : sub + '. Returning to the campaign map...', { leave });
  }

  function onCamp(m) {
    if (leaving) return;
    if (m.you === 0 || m.you === 1) me = m.you;
    campSeen = true;
    const over = m.winner === 0 || m.winner === 1 || m.winner === -1;
    // A campaign view that only repeats "a battle is being fought" must not hide that battle.
    const keepBattle = battle.live && screen === 'battle' && m.phase === 'battle' && !over;
    if (!keepBattle) {
      battle.live = false;
      if (!over) hideEnd();
      setScreen('camp');
    }
    callRenderCamp(m);
    // campaign.js announces the result; if it could not, make sure the player is not stuck
    if (over && !(endShown && endLeave)) {
      const title = m.winner === me ? 'CAMPAIGN VICTORY' : m.winner === -1 ? 'CAMPAIGN DRAW' : 'CAMPAIGN DEFEAT';
      showEndOverlay(title, '', { leave: true });
    }
  }

  function onPeer(m) {
    if (leaving || !room) return;
    if (m.state === 'lost') setPeerLost(m.grace);
    else if (m.state === 'back') { clearPeer(); flash('Opponent reconnected.'); }
  }

  function onLeft(m) {
    const expected = !!leaving;
    endLeaving();
    const why = m.reason === 'idle' ? 'The room was closed after a long time without activity.'
      : m.reason === 'closed' ? 'The room was closed.' : '';
    if (expected && !why) return;   // already back at the menu
    localLeave(why);
  }

  function onError(m) {
    const msg = typeof m.msg === 'string' && m.msg ? m.msg.slice(0, 200) : 'Something went wrong.';
    if (m.code === 'rejoin_failed') return rejoinFailed(msg);
    if (m.code === 'shutdown') return onShutdown(msg);
    showError(msg);
  }

  // The server announced a restart. It closes the socket itself; one that lingers is cycled.
  function onShutdown(msg) {
    conn.notice = msg;
    clearTimeout(conn.noticeTimer);
    conn.noticeTimer = setTimeout(() => { if (conn.notice) forceReconnect(); }, SHUTDOWN_WAIT_MS);
    renderBanner();
  }

  // ---------- room membership ----------
  function inCampaign() {
    return campSeen || (!!room && room.mode === 'campaign');
  }

  // Drop every trace of the current game (not the room itself).
  function forgetGame() {
    battle.live = false;
    campSeen = false;
    clearBattle();
    clearPeer();
    hideEnd();
    callCampaignReset();
  }

  // We are in no room any more: forget the seat and show the menu.
  function localLeave(msg) {
    saveSeat(null);
    room = null;
    endRejoin();
    flashText = '';
    forgetGame();
    setScreen('menu');
    setText('err', msg || '');
    renderBanner();
  }

  // "Return to lobby": the room is still joined, the game in it is finished.
  function backToRoom() {
    forgetGame();
    if (!room) return setScreen('menu');
    syncPeer(room);
    setScreen('room');
    renderRoom();
  }

  // Leave the room now. Callers confirm first when that means a forfeit.
  function leaveRoom() {
    const seated = !!room || !!seat || screen !== 'menu';
    const code = room ? room.code : seat ? seat.code : null;
    const sent = seated && send({ t: 'leave' });
    endLeaving();
    localLeave('');
    if (!sent) return;
    // Until the server confirms, messages about the old room are ignored. No reply at all
    // means we may still hold the seat on this socket, so a fresh connection is the way out.
    leaving = { code };
    leaveTimer = setTimeout(() => {
      if (!leaving) return;
      leaving = null;
      forceReconnect();
    }, LEAVE_WAIT_MS);
  }
  function endLeaving() {
    leaving = null;
    clearTimeout(leaveTimer);
  }

  function quitGame() {
    const ask = 'Quit this game? You will forfeit.';
    if (typeof confirm === 'function' && !confirm(ask)) return;
    leaveRoom();
  }

  // ---------- screens ----------
  function setScreen(name) {
    screen = name;
    show('lobby', name === 'menu' || name === 'room');
    show('camp', name === 'camp');
    show('game', name === 'battle');
    renderMenu();
    updateQuit();
    if (name === 'battle') { layout(); startLoop(); } else cancelPointer();
  }

  // The menu is replaced by a note while a stored seat is being rejoined (page reload).
  function renderMenu() {
    const waiting = screen === 'menu' && !!seat && !room && conn.state !== 'dead';
    show('menu', screen === 'menu' && !waiting);
    show('rejoinNote', waiting);
    show('roomView', screen === 'room');
  }

  function playerLine(p, i) {
    const name = p && typeof p.name === 'string' ? p.name.slice(0, 24) : 'Commander';
    const status = !p ? '' : p.connected === false ? 'disconnected' : p.ready ? 'ready' : 'not ready';
    return `${i === 0 ? '\u{1F985}' : '\u{1F3FA}'} ${name}${i === me ? ' (you)' : ''} - ${status}`;
  }

  function renderRoom() {
    if (!room) return;
    setText('roomCode', room.code.slice(0, 8));
    setText('modeLabel', room.mode === 'campaign' ? 'Campaign' : 'Single battle');
    const box = $('players');
    if (box) {
      box.textContent = '';
      room.players.slice(0, 2).forEach((p, i) => box.appendChild(make('div', 'pl', playerLine(p, i))));
      if (room.players.length < 2) box.appendChild(make('div', 'pl', 'Waiting for an opponent... share the code.'));
    }
    const btn = $('btnReady');
    if (!btn) return;
    const idle = room.phase === 'lobby' || room.phase === 'over', mine = room.players[me];
    btn.disabled = !idle || !mine || !!mine.ready;
    btn.textContent = !idle ? 'Game in progress' : room.phase === 'over' ? 'Ready for a rematch'
      : room.mode === 'campaign' ? 'Ready for campaign' : 'Ready for battle';
  }

  function showError(msg) {
    setText('err', msg);
    if (screen === 'battle' || screen === 'camp') flash(msg);   // the lobby box is hidden there
  }

  function showEndOverlay(title, sub, opts) {
    endShown = true;
    endLeave = !!(opts && opts.leave);
    setText('endText', String(title === undefined || title === null ? '' : title));
    setText('endSub', String(sub === undefined || sub === null ? '' : sub));
    show('btnAgain', endLeave, 'inline-block');
    show('end', true, 'flex');
    updateQuit();
  }
  function hideEnd() {
    endShown = false; endLeave = false;
    show('end', false);
    updateQuit();
  }

  // Quit is offered while a game is on screen, except next to the "Return to lobby" button.
  function updateQuit() {
    const el = $('btnQuit');
    if (!el) return;
    const on = (screen === 'battle' || screen === 'camp') && !(endShown && endLeave);
    el.style.display = on ? 'block' : 'none';
    el.className = 'quiet mini' + (screen === 'camp' ? ' onMap' : '');
  }

  function setHelp(on) {
    helpOpen = !!on;
    show('help', helpOpen, 'flex');
  }

  // ---------- banner (connection first, then opponent, then passing notes) ----------
  function bannerState() {
    if (conn.state === 'dead') {
      return { text: conn.everOpen ? 'Could not reconnect.' : 'Could not reach the server.', reload: true };
    }
    if (conn.state === 'lost') {
      return { text: conn.full ? 'The server is full. Retrying...' : 'Connection lost. Reconnecting...' };
    }
    if (conn.state === 'connecting') {
      if (conn.full) return { text: 'The server is full. Retrying...' };
      return conn.waking ? { text: 'Waking the server. This can take up to a minute on free hosting.' } : null;
    }
    if (conn.notice) return { text: conn.notice };
    if (peer.lost && room) {
      const left = Math.max(0, Math.ceil((peer.until - Date.now()) / 1000));
      return { text: `Opponent disconnected. Waiting up to ${left} s` };
    }
    return flashText ? { text: flashText } : null;
  }

  let bannerKey = '';
  function renderBanner() {
    const el = $('banner');
    if (!el) return;
    const b = bannerState(), key = b ? b.text + (b.reload ? '|r' : '') : '';
    if (key === bannerKey) return;
    bannerKey = key;
    el.textContent = '';
    el.style.display = b ? 'block' : 'none';
    if (!b) return;
    el.appendChild(make('span', '', b.text));
    if (!b.reload) return;
    const btn = make('button', '', 'Reload');
    btn.type = 'button';
    btn.addEventListener('click', () => location.reload());
    el.appendChild(btn);
  }

  function flash(text) {
    flashText = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashText = ''; renderBanner(); }, 3000);
    renderBanner();
  }

  function setPeerLost(grace) {
    if (isNum(grace)) peer.until = Date.now() + clamp(grace, 0, 3600) * 1000;
    else if (!peer.lost) peer.until = Date.now() + 60000;
    peer.lost = true;
    if (!peer.timer) peer.timer = setInterval(renderBanner, 500);
    renderBanner();
  }
  function clearPeer() {
    peer.lost = false;
    clearInterval(peer.timer);
    peer.timer = 0;
    renderBanner();
  }
  function syncPeer(m) {
    const other = m.players[1 - me];
    if (other && !other.bot && other.connected === false) setPeerLost(other.grace);
    else if (peer.lost) clearPeer();
  }

  // ---------- battle state ----------
  const fit = r => r.state !== 'dead' && r.state !== 'rout';   // can still take orders
  const isMine = r => r.owner === me;

  function parseReg(a) {
    if (!Array.isArray(a) || a.length < 9) return null;
    if (!Number.isInteger(a[0]) || !isNum(a[3]) || !isNum(a[4])) return null;
    const x = clamp(a[3], -FAR, FAR), y = clamp(a[4], -FAR, FAR);
    return { id: a[0], owner: a[1] === 1 ? 1 : 0, type: String(a[2]).slice(0, 24), x, y,
      face: isNum(a[5]) ? clamp(a[5], -FAR, FAR) : 0, men: isNum(a[6]) ? clamp(Math.round(a[6]), 0, MAX_MEN) : 0,
      morale: isNum(a[7]) ? clamp(a[7], 0, 100) : 0, state: a[8], ammo: isNum(a[9]) ? a[9] : 0,
      engaged: Number.isInteger(a[10]) ? a[10] : 0, dx: x, dy: y };
  }

  function typeInfo(type) {
    const t = own(battle.types, type) ? battle.types[type] : null;
    return t && typeof t === 'object' ? t : null;
  }

  function clearBattle() {
    battle.regs = []; battle.byId = new Map(); battle.prevById = new Map();
    battle.startMen.clear();
    battle.time = 0; battle.left = null;
    battle.simAt = 0; battle.moving = false; battle.held = []; battle.pauseNote = false;
    selected.clear();
    cancelPointer();
    fx = [];
    clearCards();
  }

  function beginBattle(m) {
    clearBattle();
    battle.live = true;
    battle.W = isNum(m.W) && m.W >= 100 && m.W <= FAR ? m.W : 1600;
    battle.H = isNum(m.H) && m.H >= 100 && m.H <= FAR ? m.H : 900;
    battle.types = m.types && typeof m.types === 'object' ? m.types : {};
    battle.limit = isNum(m.limit) ? clamp(m.limit, 0, 86400) : 0;
  }

  function pruneSelection() {
    for (const id of selected) {
      const r = battle.byId.get(id);
      if (!r || !isMine(r) || !fit(r)) selected.delete(id);
    }
  }
  function selectWhere(pred, add) {
    if (!add) selected.clear();
    for (const r of battle.regs) if (isMine(r) && fit(r) && pred(r)) selected.add(r.id);
    updateCards();
  }
  function selectedRegs() {
    return battle.regs.filter(r => selected.has(r.id) && isMine(r) && fit(r)).slice(0, MAX_ORDER_UNITS);
  }

  // Nearest regiment accepted by `pred` within the hit radius (at least 18 px on small screens).
  function regimentAt(x, y, pred) {
    let best = null, bd = Math.max(HIT_RADIUS, 18 / view.scale);
    for (const r of battle.regs) {
      if (r.state === 'dead' || !pred(r)) continue;
      const d = Math.hypot(r.x - x, r.y - y);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  // ---------- orders ----------
  const fieldX = x => clamp(x, FIELD_MARGIN, battle.W - FIELD_MARGIN);
  const fieldY = y => clamp(y, FIELD_MARGIN, battle.H - FIELD_MARGIN);

  // The server ignores battle orders while the game is paused, so an order given while sim time
  // stands still is also kept and sent again once it moves (orders are idempotent).
  function order(obj) {
    if (!battle.live || !battle.regs.length) return false;
    if (!battle.moving || ticks() - battle.simAt > STALL_MS) {
      battle.held.push(obj);
      if (battle.held.length > MAX_HELD) battle.held.shift();
    }
    return send(obj);
  }
  function mark(x, y, kind) {
    fx.push({ x, y, kind, at: ticks() });
    if (fx.length > 60) fx.shift();
  }

  function orderAttack(regs, foe) {
    if (order({ t: 'attack', ids: regs.map(r => r.id), target: foe.id })) mark(foe.x, foe.y, 'attack');
  }

  // Several regiments keep their offsets from the group's centroid; all go out in one frame.
  function orderMove(regs, x, y) {
    if (regs.length === 1) {
      const tx = r1(fieldX(x)), ty = r1(fieldY(y));
      if (order({ t: 'move', ids: [regs[0].id], x: tx, y: ty })) mark(tx, ty, 'move');
      return;
    }
    let cx = 0, cy = 0;
    for (const r of regs) { cx += r.x / regs.length; cy += r.y / regs.length; }
    const list = regs.map(r => [r.id, r1(fieldX(x + r.x - cx)), r1(fieldY(y + r.y - cy))]);
    if (order({ t: 'moves', list })) for (const l of list) mark(l[1], l[2], 'move');
  }

  // Facing for a line: perpendicular to it, toward the enemy centroid (or the enemy's edge).
  function lineFacing(a, b) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const foes = battle.regs.filter(r => !isMine(r) && r.state !== 'dead');
    let side = (me === 0 ? 1 : -1) * nx;
    if (foes.length) {
      let ex = 0, ey = 0;
      for (const f of foes) { ex += f.x / foes.length; ey += f.y / foes.length; }
      side = (ex - (a.x + b.x) / 2) * nx + (ey - (a.y + b.y) / 2) * ny;
    }
    if (side < 0) { nx = -nx; ny = -ny; }
    return Math.atan2(ny, nx);
  }

  // Evenly spaced slots on the segment a-b, handed out in the order the regiments stand along it.
  function lineSlots(regs, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const along = r => ((r.x - a.x) * dx + (r.y - a.y) * dy) / len;
    const sorted = regs.slice().sort((p, q) => along(p) - along(q) || p.id - q.id);
    const face = Math.round(lineFacing(a, b) * 1000) / 1000;
    return sorted.map((r, i) => {
      const t = (i + 0.5) / sorted.length;
      return { id: r.id, x: r1(fieldX(a.x + dx * t)), y: r1(fieldY(a.y + dy * t)), face };
    });
  }

  function orderLine(regs, a, b) {
    const slots = lineSlots(regs, a, b);
    if (order({ t: 'moves', list: slots.map(s => [s.id, s.x, s.y, s.face]) })) {
      for (const s of slots) mark(s.x, s.y, 'move');
    }
  }

  // ---------- mouse ----------
  function toWorld(e) {
    const cv = $('cv');
    const rect = cv && cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: (e.clientX - rect.left - view.ox) / view.scale, y: (e.clientY - rect.top - view.oy) / view.scale };
  }
  const onField = p => ({ x: clamp(p.x, 0, battle.W), y: clamp(p.y, 0, battle.H) });
  const lineLength = l => Math.hypot(l.x1 - l.x0, l.y1 - l.y0);

  function cancelPointer() {
    pointer.box = null;
    pointer.line = null;
  }

  function onMouseDown(e) {
    if (screen !== 'battle' || helpOpen) return;
    const w = toWorld(e);
    if (!isNum(w.x) || !isNum(w.y)) return;
    if (e.button === 0) pointer.box = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, shift: !!e.shiftKey };
    else if (e.button === 2 && battle.live && selected.size) {
      const p = onField(w);
      pointer.line = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    }
  }

  function onMouseMove(e) {
    if (screen !== 'battle') return;
    const w = toWorld(e);
    if (!isNum(w.x) || !isNum(w.y)) return;
    pointer.x = w.x; pointer.y = w.y;
    if (pointer.box) { pointer.box.x1 = w.x; pointer.box.y1 = w.y; }
    if (pointer.line) { const p = onField(w); pointer.line.x1 = p.x; pointer.line.y1 = p.y; }
  }

  function onMouseUp(e) {
    if (e.button === 0 && pointer.box) { const b = pointer.box; pointer.box = null; finishBox(b); }
    if (e.button === 2 && pointer.line) { const l = pointer.line; pointer.line = null; finishRightClick(l); }
  }

  function finishBox(b) {
    if (screen !== 'battle') return;
    const slack = 5 / view.scale;
    if (Math.abs(b.x1 - b.x0) < slack && Math.abs(b.y1 - b.y0) < slack) {
      const r = regimentAt(b.x0, b.y0, q => isMine(q) && fit(q));
      if (!b.shift) selected.clear();
      if (r) selected.add(r.id);
      return updateCards();
    }
    const xa = Math.min(b.x0, b.x1), xb = Math.max(b.x0, b.x1), ya = Math.min(b.y0, b.y1), yb = Math.max(b.y0, b.y1);
    selectWhere(r => r.x >= xa && r.x <= xb && r.y >= ya && r.y <= yb, b.shift);
  }

  function finishRightClick(l) {
    const regs = selectedRegs();
    if (screen !== 'battle' || !battle.live || !regs.length) return;
    if (lineLength(l) > LINE_DRAG_MIN) return orderLine(regs, { x: l.x0, y: l.y0 }, { x: l.x1, y: l.y1 });
    // enemies first: an enemy under the cursor wins over a nearer friendly regiment
    const foe = regimentAt(l.x0, l.y0, r => !isMine(r));
    if (foe) orderAttack(regs, foe); else orderMove(regs, l.x0, l.y0);
  }

  // ---------- keyboard ----------
  function isTyping(e) {
    const t = e.target, tag = t && typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(t && t.isContentEditable);
  }

  function typeKeyIndex(e) {
    const m = /^(?:Digit|Numpad)([1-4])$/.exec(typeof e.code === 'string' ? e.code : '');
    if (m) return Number(m[1]) - 1;
    return /^[1-4]$/.test(e.key) ? Number(e.key) - 1 : -1;
  }

  function onKeyDown(e) {
    if (typeof e.key !== 'string' || isTyping(e)) return;
    const k = e.key.toLowerCase();
    if (helpOpen) {
      if (k === 'escape' || k === 'h' || k === '?') { setHelp(false); e.preventDefault(); }
      return;
    }
    if (screen !== 'battle' || e.altKey || e.repeat) return;
    if (e.ctrlKey || e.metaKey) {
      if (k === 'a') { selectWhere(() => true, false); e.preventDefault(); }
      return;   // leave every other browser shortcut alone
    }
    const idx = typeKeyIndex(e);
    if (k === 'a') selectWhere(() => true, false);
    else if (k === 's') stopSelected();
    else if (k === 'escape') { selected.clear(); cancelPointer(); updateCards(); }
    else if (k === 'h' || k === '?') setHelp(true);
    else if (idx >= 0) selectWhere(r => r.type === TYPE_KEYS[idx], !!e.shiftKey);
  }

  function stopSelected() {
    const ids = selectedRegs().map(r => r.id);
    if (ids.length) order({ t: 'stop', ids });
  }

  // ---------- HUD and unit cards ----------
  function clockText(s) {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function updateHud() {
    const men = [0, 0], units = [0, 0];
    for (const r of battle.regs) if (fit(r)) { men[r.owner] += r.men; units[r.owner]++; }
    const known = battle.regs.length > 0;
    setText('hudMe', known ? `You: ${men[me]} men (${plural(units[me], 'unit')})` : 'You: -');
    setText('hudFoe', known ? `Enemy: ${men[1 - me]} men (${plural(units[1 - me], 'unit')})` : 'Enemy: -');
    let left = battle.left;
    if (left === null && known && battle.limit > 0) left = Math.max(0, Math.ceil(battle.limit - battle.time));
    if (left === null && !known && battle.limit > 0) left = Math.ceil(battle.limit);
    const clock = $('hudClock');
    if (clock) {
      setText('hudClock', (left === null ? '--:--' : clockText(left)) + (battle.pauseNote ? ' (paused)' : ''));
      clock.style.color = left !== null && left < 30 ? '#ff5a4d' : '';
      clock.style.fontWeight = left !== null && left < 30 ? 'bold' : '';
    }
    const side = $('hudSide');
    if (side) {
      setText('hudSide', `You are ${SIDE_TEXT[me][0]}`);
      side.style.color = SIDE_TEXT[me][1];
    }
  }

  function clearCards() {
    cardEls.clear();
    const box = $('cards');
    if (box) box.textContent = '';
  }

  // One card per own regiment, built once per battle from the first snapshot.
  function buildCards() {
    clearCards();
    const box = $('cards');
    if (!box) return;
    for (const r of battle.regs) {
      if (!isMine(r)) continue;
      const info = typeInfo(r.type);
      const name = info && typeof info.name === 'string' ? info.name.slice(0, 40) : r.type;
      const el = make('div', 'card');
      el.setAttribute('data-id', String(r.id));
      el.title = name;
      const men = make('div', 'mn'), barBox = make('div', 'mb'), bar = make('i');
      barBox.appendChild(bar);
      el.appendChild(make('div', 'nm', `${own(GLYPH, r.type) ? GLYPH[r.type] : '\u25A0'} ${name}`));
      el.appendChild(men);
      el.appendChild(barBox);
      box.appendChild(el);
      cardEls.set(r.id, { el, men, bar, key: '' });
    }
  }

  function updateCards() {
    for (const [id, c] of cardEls) {
      const r = battle.byId.get(id);
      const state = !r ? 'dead' : r.state, out = state === 'dead' || state === 'rout';
      const menNow = r && state !== 'dead' ? r.men : 0, morale = r && !out ? r.morale : 0;
      const sel = selected.has(id);
      const key = `${menNow}|${morale}|${state}|${sel}`;
      if (key === c.key) continue;
      c.key = key;
      const tag = state === 'dead' ? ' - lost' : state === 'rout' ? ' - routing' : '';
      c.men.textContent = `${menNow} / ${battle.startMen.get(id) || menNow}${tag}`;
      c.bar.style.width = `${morale}%`;
      c.bar.style.background = morale > 50 ? '#6dd36d' : morale > 20 ? '#e8c15a' : '#e0453a';
      c.el.className = 'card' + (sel ? ' sel' : '') + (out ? ' out' : '');
    }
  }

  function cardRegiment(e) {
    const el = e.target && typeof e.target.closest === 'function' ? e.target.closest('.card') : null;
    const r = el ? battle.byId.get(Number(el.getAttribute('data-id'))) : null;
    return r && isMine(r) && fit(r) ? r : null;
  }
  function onCardClick(e) {
    const r = cardRegiment(e);
    if (!r) return;
    if (!e.shiftKey) selected.clear();
    selected.add(r.id);
    updateCards();
  }
  function onCardDouble(e) {
    const r = cardRegiment(e);
    if (r) selectWhere(q => q.type === r.type, !!e.shiftKey);
  }

  // ---------- drawing ----------
  // The field is letterboxed between the HUD strip and the unit cards.
  function layout() {
    const cv = $('cv');
    if (!cv) return;
    const w = Math.max(1, window.innerWidth || 1), h = Math.max(1, window.innerHeight || 1);
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const cards = $('cards');
    const below = cards && cardEls.size ? (cards.offsetHeight || 0) + 10 : 0;
    const room4field = Math.max(60, h - HUD_SPACE - below);
    view.dpr = dpr;
    view.scale = Math.max(0.01, Math.min(w / battle.W, room4field / battle.H));
    view.ox = (w - battle.W * view.scale) / 2;
    view.oy = HUD_SPACE + (room4field - battle.H * view.scale) / 2;
  }

  function startLoop() {
    if (loopOn || typeof requestAnimationFrame !== 'function') return;
    loopOn = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    if (screen !== 'battle') { loopOn = false; return; }
    requestAnimationFrame(frame);
    try { drawBattle(); } catch (e) {
      if (!drawFailed) console.error(e);   // once is enough at 60 frames per second
      drawFailed = true;
    }
  }

  function drawBattle() {
    const cv = $('cv'), ctx = cv && cv.getContext ? cv.getContext('2d') : null;
    if (!ctx) return;
    const k = view.scale * view.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.fillStyle = '#2f3a1e'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(k, 0, 0, k, view.ox * view.dpr, view.oy * view.dpr);
    ctx.fillStyle = '#566a33'; ctx.fillRect(0, 0, battle.W, battle.H);
    ctx.strokeStyle = '#ffffff10'; ctx.setLineDash([10, 14]);
    ctx.beginPath(); ctx.moveTo(battle.W / 2, 0); ctx.lineTo(battle.W / 2, battle.H); ctx.stroke();
    ctx.setLineDash([]);
    if (!battle.regs.length) return;
    const paused = battle.live && ticks() - battle.simAt > PAUSE_NOTE_MS;
    if (paused !== battle.pauseNote) { battle.pauseNote = paused; updateHud(); }
    placeRegiments();
    drawMarks(ctx);
    for (const r of battle.regs) if (r.state !== 'dead') drawRegiment(ctx, r);
    for (const r of battle.regs) if (r.state !== 'dead') drawLabels(ctx, r);
    drawPointer(ctx);
  }

  // Positions are eased from the previous snapshot to the latest one.
  function placeRegiments() {
    const span = clamp(battle.snapAt - battle.prevAt, 20, 250);
    const t = battle.prevById.size ? clamp((ticks() - battle.snapAt) / span, 0, 1) : 1;
    for (const r of battle.regs) {
      const p = battle.prevById.get(r.id);
      r.dx = p ? p.x + (r.x - p.x) * t : r.x;
      r.dy = p ? p.y + (r.y - p.y) * t : r.y;
    }
  }

  function drawRegiment(ctx, r) {
    const c = COL[r.owner], cav = r.type === 'cav';
    const n = clamp(Math.round(r.men / 3), 1, MAX_DOTS);
    const cols = r.type === 'archer' ? 5 : cav ? 4 : 6;
    ctx.save();
    ctx.translate(r.dx, r.dy); ctx.rotate(r.face);
    ctx.globalAlpha = r.state === 'rout' ? 0.45 : 1;
    ctx.fillStyle = cav ? c[1] : c[0]; ctx.strokeStyle = '#000a';
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols), col = i % cols;
      ctx.beginPath();
      ctx.arc(-row * 7, (col - (cols - 1) / 2) * 7, cav ? 4 : 3, 0, 7);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    const info = typeInfo(r.type), target = r.engaged ? battle.byId.get(r.engaged) : null;
    if (target && info && info.ranged && r.ammo > 0 && r.state !== 'rout') {   // arrows in flight
      ctx.strokeStyle = '#fff6';
      ctx.beginPath(); ctx.moveTo(r.dx, r.dy); ctx.lineTo(target.dx, target.dy); ctx.stroke();
    }
  }

  function drawLabels(ctx, r) {
    const x = r.dx, y = r.dy;
    if (selected.has(r.id)) {
      // selection ring with a tick showing the facing
      ctx.strokeStyle = '#7dff7d'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 26, 0, 7); ctx.stroke();
      const fx0 = Math.cos(r.face), fy0 = Math.sin(r.face);
      ctx.beginPath(); ctx.moveTo(x + fx0 * 26, y + fy0 * 26); ctx.lineTo(x + fx0 * 38, y + fy0 * 38); ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = '#000a'; ctx.fillRect(x - 18, y - 34, 36, 5);
    ctx.fillStyle = r.morale > 50 ? '#6dd36d' : r.morale > 20 ? '#e8c15a' : '#e0453a';
    ctx.fillRect(x - 18, y - 34, 36 * r.morale / 100, 5);
    ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(String(r.men), x, y - 38);
    if (r.state === 'rout') {   // white flag
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + 24, y - 28); ctx.lineTo(x + 24, y - 52); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = '#fff'; ctx.fillRect(x + 24, y - 52, 13, 9);
    }
  }

  function drawMarks(ctx) {
    const t = ticks();
    fx = fx.filter(m => t - m.at < 700);
    for (const m of fx) {
      const age = (t - m.at) / 700;
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = m.kind === 'attack' ? '#ff5a4d' : '#7dff7d'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.kind === 'attack' ? 30 - 12 * age : 6 + 10 * age, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 1;
  }

  function drawPointer(ctx) {
    const b = pointer.box, l = pointer.line;
    if (b) {
      ctx.strokeStyle = '#7dff7d';
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    if (l && lineLength(l) > LINE_DRAG_MIN) return drawLinePreview(ctx, l);
    if (b || l || !battle.live || !selected.size) return;
    const foe = regimentAt(pointer.x, pointer.y, r => !isMine(r));   // what a right-click would attack
    if (!foe) return;
    ctx.strokeStyle = '#ff5a4d'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(foe.dx, foe.dy, 28, 0, 7); ctx.stroke();
    ctx.lineWidth = 1;
  }

  function drawLinePreview(ctx, l) {
    const slots = lineSlots(selectedRegs(), { x: l.x0, y: l.y0 }, { x: l.x1, y: l.y1 });
    ctx.strokeStyle = '#ffe27a'; ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(l.x0, l.y0); ctx.lineTo(l.x1, l.y1); ctx.stroke();
    ctx.setLineDash([]);
    for (const s of slots) {
      const cx = Math.cos(s.face), cy = Math.sin(s.face);
      ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s.x + cx * 9, s.y + cy * 9); ctx.lineTo(s.x + cx * 22, s.y + cy * 22); ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  // ---------- menu and buttons ----------
  function playerName() {
    const el = $('name');
    const name = (el && typeof el.value === 'string' ? el.value : '').trim().slice(0, 16);
    if (name) store('localStorage', NAME_KEY, name);
    return name || 'Commander';
  }

  function menuSend(obj) {
    setText('err', '');
    if (send(obj)) return true;
    setText('err', conn.state === 'dead' ? 'Not connected. Reload the page.'
      : 'Not connected to the server yet. Try again in a moment.');
    return false;
  }

  function joinRoom() {
    const el = $('code');
    const code = (el && typeof el.value === 'string' ? el.value : '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return setText('err', 'Enter the 4-character room code.');
    menuSend({ t: 'join', code, name: playerName() });
  }

  function bindUi() {
    listen('btnCreate', 'click', () => menuSend({ t: 'create', name: playerName() }));
    listen('btnCamp', 'click', () => menuSend({ t: 'create', name: playerName(), mode: 'campaign' }));
    listen('btnPractice', 'click', () => menuSend({ t: 'practice', name: playerName() }));
    listen('btnCampAI', 'click', () => menuSend({ t: 'practice', name: playerName(), mode: 'campaign' }));
    listen('btnJoin', 'click', joinRoom);
    listen('code', 'keydown', e => { if (e.key === 'Enter') joinRoom(); });
    listen('btnReady', 'click', () => { if (menuSend({ t: 'ready' })) $('btnReady').disabled = true; });
    listen('btnLeave', 'click', leaveRoom);
    listen('btnForget', 'click', leaveRoom);
    listen('btnQuit', 'click', quitGame);
    listen('btnAgain', 'click', backToRoom);
    listen('btnHelp', 'click', () => setHelp(true));
    listen('btnHowTo', 'click', () => setHelp(true));
    listen('btnHelpClose', 'click', () => setHelp(false));
    listen('help', 'click', e => { if (e.target === $('help')) setHelp(false); });   // click outside the box
    listen('cv', 'mousedown', onMouseDown);
    listen(window, 'contextmenu', e => { if (screen === 'battle') e.preventDefault(); });
    listen('cards', 'mousedown', e => e.preventDefault());   // no text selection, no focus theft
    listen('cards', 'click', onCardClick);
    listen('cards', 'dblclick', onCardDouble);
    listen(window, 'mousemove', onMouseMove);
    listen(window, 'mouseup', onMouseUp);
    listen(window, 'blur', cancelPointer);
    listen(window, 'keydown', onKeyDown);
    listen(window, 'resize', () => { if (screen === 'battle') layout(); });
    listen(window, 'online', nudge);
    listen(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') nudge(); });
  }

  function boot() {
    bindUi();
    const name = stored('localStorage', NAME_KEY), el = $('name');
    if (el && typeof name === 'string' && !el.value) el.value = name.slice(0, 16);
    setScreen('menu');
    setInterval(keepAlive, PING_MS);
    setInterval(keepAwake, HEALTH_MS);
    setTimeout(() => {
      if (conn.everOpen) return;
      conn.waking = true;
      renderBanner();
    }, WAKE_NOTE_MS);
    beginOutage();   // the first connection gets the same retry budget as a reconnect
    connect();
  }

  boot();
  return { send, leaveRoom, showEndOverlay, mySeat: () => me };
})();

// ---------- shared contract with campaign.js (SPEC 8.1) ----------
function send(obj) { return LegioClient.send(obj); }
function leaveRoom() { LegioClient.leaveRoom(); }
function showEndOverlay(title, sub, opts) { LegioClient.showEndOverlay(title, sub, opts); }
function mySeat() { return LegioClient.mySeat(); }
