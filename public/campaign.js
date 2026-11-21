// Campaign map UI: SVG map in #map, side panel in #panel. Classic script, loaded after client.js.
// Uses only the shared contract of client.js: $, send, leaveRoom, escapeHtml, showEndOverlay, mySeat.
// Defines the globals renderCamp(m) and campaignReset().
// Everything else lives in this closure so no name can collide with client.js's top-level const/let.
(() => {
  'use strict';

  const QUIT_GUARD_MS = 400;
  const END_REASONS = ['capital', 'both_capitals', 'turn_limit', 'fault', 'forfeit'];
  const SIDE = [['#b3262a', 'Red'], ['#2a4f9b', 'Blue']];
  const NEUTRAL = '#6e6a5c';
  const FALLBACK_NAME = { sword: 'Shortsword Infantry', spear: 'Spear Phalanx', archer: 'Archers', cav: 'Heavy Cavalry' };
  const CSS = `
    .camp-muted{color:#a9987a}
    .camp-army{margin-top:8px}
    .camp-unit{display:flex;justify-content:space-between;gap:8px}
    .camp-deadline{margin:6px 0;padding:6px 8px;border:1px solid #d9b45a;border-radius:4px;color:#ffe27a}
    #panel button.camp-end{text-align:center;background:#2c6a2c;border-color:#4c9a4c}
    #panel button.camp-end:hover{background:#368236}
    #panel button.camp-quiet{text-align:center;background:#3a3226;border-color:#8a6d2f;font-size:13px}
    #panel button.camp-quiet:hover{background:#4a4031}
    .camp-quit{margin-top:12px}
    .camp-rules{margin-top:12px;padding:8px 10px;background:#14110c;border-radius:4px;font-size:12px;color:#bba983}
    .camp-rules ul{margin:4px 0 0;padding-left:16px}`;

  let view = null;         // last camp view, normalised
  let sel = null;          // selected province index
  let quitArmed = false;   // "Quit campaign" was clicked, waiting for the confirmation
  let quitArmedAt = 0;     // when (ms): "Yes, quit" ignores clicks right after, so a double-click cannot pass it
  let timer = null;        // the one countdown interval
  let deadlineEnd = 0;     // local clock (ms) at which the hurry-up deadline runs out
  let frozenMs = null;     // time left (ms) while the opponent is disconnected: the server stops its timer then
  let lastDl = null;       // {turn, who, frozen}: the hurry-up countdown of this turn, kept while the server pauses it
  const drawn = { map: null, panel: null };   // HTML last written, to skip no-op redraws
  const bound = { map: null, panel: null };   // elements that already carry our click listener

  // ---------- small helpers ----------
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = v => v !== null && typeof v === 'object';
  const isSeat = v => v === 0 || v === 1;
  const isIdx = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = v => (typeof v === 'string' ? v : '');
  const arr = v => (Array.isArray(v) ? v : []);
  const r1 = n => Math.round(n * 10) / 10;

  function esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s));
    return String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
  }

  function fallbackSeat() {
    const s = typeof mySeat === 'function' ? mySeat() : 0;
    return isSeat(s) ? s : 0;
  }

  // ---------- view normalisation ----------
  // Copy the server view into a fully typed object, so rendering needs no further checks and
  // only ever interpolates numbers we validated, our own constants, or escaped strings.
  function normalise(m) {
    if (!isObj(m) || !Array.isArray(m.provs) || !Array.isArray(m.armies)) return null;
    const n = m.provs.length;
    const you = isSeat(m.you) ? m.you : fallbackSeat();
    const armies = m.armies.map(a => cleanArmy(a, n)).filter(Boolean);
    const winner = isSeat(m.winner) || m.winner === -1 ? m.winner : null;
    const phase = str(m.phase);
    const owners = arr(m.owner), ready = arr(m.ready);
    return {
      you, winner, phase, armies,
      turn: num(m.turn, 1),
      gold: num(m.gold), units: num(m.units), maxUnits: num(m.maxUnits, Infinity),
      income: Number.isFinite(m.income) ? m.income : null,
      replenish: num(m.replenish, 0.25),
      types: isObj(m.types) ? m.types : {},
      cost: cleanCost(m.cost),
      provs: m.provs.map(p => (isObj(p) ? p : {})).map(p => ({ name: str(p.name), x: num(p.x), y: num(p.y) })),
      edges: arr(m.edges).filter(e => Array.isArray(e) && isIdx(e[0], n) && isIdx(e[1], n)),
      capital: arr(m.capital).filter(i => isIdx(i, n)),
      owner: m.provs.map((_, i) => (isSeat(owners[i]) ? owners[i] : -1)),
      moves: cleanMoves(m.moves, armies, you, n),
      ready: [!!ready[0], !!ready[1]],
      log: arr(m.log).filter(l => typeof l === 'string').slice(-8),
      opponent: str(m.opponent),
      turnLimit: Number.isInteger(m.turnLimit) && m.turnLimit > 0 && m.turnLimit <= 100000 ? m.turnLimit : null,
      endReason: END_REASONS.includes(m.endReason) ? m.endReason : null,
      deadline: phase === 'orders' && winner === null ? cleanDeadline(m.deadline) : null,
    };
  }

  function cleanArmy(a, n) {
    if (!isObj(a) || !Number.isInteger(a.id) || !isSeat(a.owner) || !isIdx(a.prov, n)) return null;
    const units = arr(a.units).filter(isObj).map(u => ({ type: str(u.type), men: Math.max(0, Math.round(num(u.men))) }));
    return { id: a.id, owner: a.owner, prov: a.prov, units };
  }

  function cleanCost(cost) {
    if (!isObj(cost)) return [];
    return Object.keys(cost).filter(t => Number.isFinite(cost[t])).map(t => ({ type: t, gold: cost[t] }));
  }

  // Pending marches as Map(armyId -> province), own armies only.
  function cleanMoves(moves, armies, you, n) {
    const out = new Map();
    if (!isObj(moves)) return out;
    for (const key of Object.keys(moves)) {
      const a = armies.find(x => x.id === Number(key) && x.owner === you);
      if (a && isIdx(moves[key], n)) out.set(a.id, moves[key]);
    }
    return out;
  }

  function cleanDeadline(d) {
    if (!isObj(d) || !isSeat(d.who) || !Number.isFinite(d.left)) return null;
    return { who: d.who, left: Math.max(0, d.left), paused: false };
  }

  // While the room is paused (a player is away) the server sends the camp view with deadline: null, so
  // the countdown would vanish. Within the same turn, a missing deadline after a known one is that pause:
  // keep the last time left, frozen, and mark it paused. It runs again when the server sends a deadline.
  function carryDeadline(v) {
    const live = v.phase === 'orders' && v.winner === null;
    if (!live) { lastDl = null; return; }
    if (v.deadline) { lastDl = { turn: v.turn, who: v.deadline.who, frozen: null }; return; }
    if (!lastDl || lastDl.turn !== v.turn) { lastDl = null; return; }
    if (lastDl.frozen === null) lastDl.frozen = Math.max(0, frozenMs !== null ? frozenMs : deadlineEnd - Date.now()) / 1000;   // stands still from now on
    v.deadline = { who: lastDl.who, left: lastDl.frozen, paused: true };
  }

  // ---------- queries on a view ----------
  const canOrder = v => v.phase === 'orders' && !v.ready[v.you] && v.winner === null;
  const adjacent = (v, a, b) => v.edges.some(e => (e[0] === a && e[1] === b) || (e[1] === a && e[0] === b));
  const armiesAt = (v, prov) => v.armies.filter(a => a.prov === prov).sort((a, b) => a.owner - b.owner);
  const selectedArmy = v => (sel === null ? null : v.armies.find(a => a.owner === v.you && a.prov === sel) || null);
  const provRadius = (v, i) => (v.capital.includes(i) ? 34 : 28);

  function unitInfo(v, type) {
    const t = own(v.types, type) && isObj(v.types[type]) ? v.types[type] : {};
    const fallback = own(FALLBACK_NAME, type) ? FALLBACK_NAME[type] : type;
    return { name: str(t.name) || fallback, max: num(t.men) };
  }

  // ---------- map ----------
  function mapHtml(v) {
    const colour = SIDE[v.you][0], army = selectedArmy(v), orders = canOrder(v);
    const out = [`<defs><marker id="ah" viewBox="0 0 8 8" markerWidth="4" markerHeight="4" refX="5" refY="4" orient="auto">` +
      `<path d="M0,0 L8,4 L0,8z" fill="${colour}"/></marker></defs>`];
    for (const [a, b] of v.edges) {
      const A = v.provs[a], B = v.provs[b];
      out.push(`<line x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}" stroke="#6b5a36" stroke-width="3"/>`);
    }
    v.provs.forEach((_, i) => out.push(provSvg(v, i, !!(orders && army && adjacent(v, army.prov, i)))));
    for (const a of v.armies) out.push(badgeSvg(v, a));
    // marches go last so the arrowheads are not hidden under the province discs
    for (const [id, to] of v.moves) out.push(marchSvg(v, v.armies.find(a => a.id === id), to, colour));
    return out.join('');
  }

  function provSvg(v, i, reachable) {
    const p = v.provs[i], o = v.owner[i], cap = v.capital.includes(i), picked = sel === i;
    const stroke = picked ? '#7dff7d' : reachable ? '#ffe27a' : '#1b1712';
    return `<g class="prov" data-p="${i}">` +
      `<circle cx="${p.x}" cy="${p.y}" r="${provRadius(v, i)}" fill="${o < 0 ? NEUTRAL : SIDE[o][0]}" stroke="${stroke}" stroke-width="${picked || reachable ? 5 : 3}"/>` +
      (cap ? `<text x="${p.x}" y="${p.y + 8}" text-anchor="middle" font-size="26" fill="#ffe9a8">&#9733;</text>` : '') +
      `<text x="${p.x}" y="${p.y + (cap ? 54 : 48)}" text-anchor="middle" font-size="14" fill="#e9dfc8">${esc(p.name)}</text></g>`;
  }

  // Army marker: a small banner above the province showing the number of units.
  function badgeSvg(v, a) {
    const p = v.provs[a.prov], bx = p.x + (a.owner === 0 ? -34 : 6), by = p.y - 50;
    return `<g pointer-events="none"><rect x="${bx}" y="${by}" width="30" height="22" rx="3" fill="${SIDE[a.owner][0]}" stroke="#ffe9a8" stroke-width="2"/>` +
      `<text x="${bx + 15}" y="${by + 16}" text-anchor="middle" font-size="14" font-weight="bold" fill="#fff">${a.units.length}</text></g>`;
  }

  function marchSvg(v, a, to, colour) {
    if (!a || a.prov === to) return '';
    const A = v.provs[a.prov], B = v.provs[to];
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
    // start at the rim of the origin, stop short of the target (the arrowhead adds about 9 units)
    let from = provRadius(v, a.prov), stop = provRadius(v, to) + 11;
    if (len < from + stop + 10) { from = 0; stop = 0; }
    const ux = len ? dx / len : 0, uy = len ? dy / len : 0;
    return `<line pointer-events="none" x1="${r1(A.x + ux * from)}" y1="${r1(A.y + uy * from)}" x2="${r1(B.x - ux * stop)}" y2="${r1(B.y - uy * stop)}" ` +
      `stroke="${colour}" stroke-width="6" stroke-dasharray="10 8" marker-end="url(#ah)"/>`;
  }

  // ---------- side panel ----------
  function panelHtml(v) {
    return headHtml(v) + '<hr>' + provHtml(v) + '<hr>' + statusHtml(v) + '<hr>' + logHtml(v) + rulesHtml(v) + quitHtml(v);
  }

  function headHtml(v) {
    const me = v.you, owned = v.owner.filter(o => o === me).length;
    const cap = Number.isFinite(v.maxUnits) ? `/${v.maxUnits}` : '';
    const income = v.income === null ? '' : ` &middot; Income: +${v.income * owned}/turn`;
    const foe = v.opponent ? ` vs ${esc(v.opponent)}` : '';
    const turn = v.turnLimit === null ? `Turn ${v.turn}` : `Turn ${v.turn} of ${v.turnLimit}`;
    return `<h2>${turn}</h2>` +
      `<div>You command <b style="color:${SIDE[me][0]}">${SIDE[me][1]}</b>${foe}</div>` +
      `<div>Gold: <b>${v.gold}</b> &middot; Units: ${v.units}${cap}${income}</div>`;
  }

  function provHtml(v) {
    if (sel === null) {
      return '<div class="camp-muted">Select one of your provinces to recruit or move its army. ' +
        'Then select a highlighted neighbour to march there. Click the empty map to deselect.</div>';
    }
    const me = v.you, o = v.owner[sel], orders = canOrder(v);
    const held = o < 0 ? 'Unclaimed' : `Held by ${SIDE[o][1]}${o === me ? ' (you)' : ''}`;
    const capOf = [0, 1].find(s => v.capital[s] === sel);
    let h = `<h2>${esc(v.provs[sel].name)}</h2><div>${held}${capOf === undefined ? '' : ` &middot; ${SIDE[capOf][1]} capital`}</div>`;
    // The recruit buttons come first: a recruit adds rows to the army list, and nothing above a button
    // may change height, or the next click (pointer unmoved) would land on another unit type.
    if (o === me && orders) h += recruitHtml(v);
    for (const a of armiesAt(v, sel)) h += armyHtml(v, a, orders);
    return h;
  }

  function armyHtml(v, a, orders) {
    const men = a.units.reduce((s, u) => s + u.men, 0);
    let h = `<div class="camp-army"><b style="color:${SIDE[a.owner][0]}">${SIDE[a.owner][1]} army</b> ` +
      `<span class="camp-muted">${a.units.length} units, ${men} men</span>`;
    for (const u of a.units) {
      const info = unitInfo(v, u.type);
      h += `<div class="camp-unit"><span>${esc(info.name)}</span><span>${u.men}${info.max ? ` / ${info.max}` : ''}</span></div>`;
    }
    h += '</div>';
    if (a.owner !== v.you) return h;
    if (v.moves.has(a.id)) {
      h += `<div class="camp-army">Marching to <b>${esc(v.provs[v.moves.get(a.id)].name)}</b></div>`;
      if (orders) h += '<button data-act="cancel">Cancel march</button>';
    } else if (orders) {
      h += '<div class="camp-muted">Click a highlighted neighbour to march there.</div>';
    }
    return h;
  }

  function recruitHtml(v) {
    const full = v.units >= v.maxUnits;
    let h = '<div class="camp-army"><b>Recruit here</b></div>';
    v.cost.forEach((c, i) => {
      const off = full || v.gold < c.gold ? ' disabled' : '';
      h += `<button data-act="recruit" data-i="${i}"${off}>${esc(unitInfo(v, c.type).name)} &mdash; ${c.gold}g</button>`;
    });
    if (full) h += '<div class="camp-muted">Unit cap reached.</div>';
    return h;
  }

  function statusHtml(v) {
    if (v.winner !== null) {
      const text = v.winner === -1 ? 'The campaign ends in a draw.' : v.winner === v.you ? 'Campaign won!' : 'Campaign lost.';
      return `<div><b>${text}</b></div><div class="camp-muted">${esc(endReasonText(v))}</div>`;
    }
    if (v.phase === 'battle') return '<div>A battle is being fought&hellip;</div>';
    if (v.phase !== 'orders') return '<div>Armies are on the march&hellip;</div>';
    // the countdown text is filled in by paintDeadline so that a ticking number never forces a redraw
    const deadline = v.deadline ? '<div id="campDeadline" class="camp-deadline"></div>' : '';
    if (v.ready[v.you]) return '<div>Orders sent. Waiting for opponent&hellip;</div>' + deadline;
    return deadline + '<button data-act="end" class="camp-end">End turn</button>';
  }

  const logHtml = v => `<div id="log">${v.log.map(l => `<div>${esc(l)}</div>`).join('')}</div>`;

  function rulesHtml(v) {
    const pct = Math.round(v.replenish * 100);
    return '<div class="camp-rules"><b>Rules</b><ul>' +
      `<li>Units regain ${pct}% strength per turn in friendly provinces.</li>` +
      '<li>Survivors regroup after a battle.</li>' +
      "<li>The province owner defends. If time runs out, the army that kept more of its starting strength wins; the defender only needs three quarters of the attacker's share.</li>" +
      '<li>Armies that cross paths turn back.</li>' +
      '<li>Take the enemy capital to win.</li>' +
      (v.turnLimit === null ? '' : `<li>The campaign ends after turn ${v.turnLimit}: the player with more provinces wins.</li>`) +
      '</ul></div>';
  }

  function quitHtml(v) {
    if (!quitArmed) return '<div class="camp-quit"><button data-act="quit" class="camp-quiet">Quit campaign</button></div>';
    const ask = v.winner === null ? 'Quit the campaign? You will forfeit.' : 'Leave this room?';
    return `<div class="camp-quit"><div>${ask}</div>` +
      '<button data-act="quit-yes">Yes, quit</button><button data-act="quit-no" class="camp-quiet">Keep playing</button></div>';
  }

  // ---------- drawing ----------
  function ensureStyle() {
    if ($('campStyle') || !document.head) return;
    const s = document.createElement('style');
    s.id = 'campStyle';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // One delegated listener per container: redraws replace the children, never the listener.
  function bind(key, el, handler) {
    if (bound[key] === el) return;
    el.addEventListener('click', handler);
    bound[key] = el;
    drawn[key] = null;
  }

  function setHtml(key, el, html) {
    if (drawn[key] === html) return false;
    el.innerHTML = html;
    drawn[key] = html;
    return true;
  }

  // Redraw from the cached view. Safe to call any number of times.
  function draw() {
    const v = view, map = $('map'), panel = $('panel');
    if (!v || !map || !panel) return;
    ensureStyle();
    bind('map', map, onMapClick);
    bind('panel', panel, onPanelClick);
    setHtml('map', map, mapHtml(v));
    const top = panel.scrollTop;
    if (setHtml('panel', panel, panelHtml(v))) panel.scrollTop = top;
    paintDeadline();
  }

  // ---------- deadline countdown ----------
  function stopTimer() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    frozenMs = null;
  }

  function syncDeadline() {
    if (!view || !view.deadline) return stopTimer();
    deadlineEnd = Date.now() + view.deadline.left * 1000;
    frozenMs = view.deadline.paused ? view.deadline.left * 1000 : null;
    if (timer === null) timer = setInterval(paintDeadline, 250);
  }

  // client.js knows whether the opponent is disconnected (the room is paused, the server's hurry-up
  // timer stands still): then the shown time stands still too.
  function opponentAway() {
    try { return typeof peerAway === 'function' && peerAway() === true; } catch (e) { return false; }
  }

  function paintDeadline() {
    if (!view || !view.deadline) return stopTimer();
    const now = Date.now();
    if (view.deadline.paused || opponentAway()) {
      if (frozenMs === null) frozenMs = Math.max(0, deadlineEnd - now);
    } else if (frozenMs !== null) {
      deadlineEnd = now + frozenMs;   // resume from where it stood
      frozenMs = null;
    }
    const el = $('campDeadline');
    if (!el) return;
    const left = Math.max(0, Math.ceil((frozenMs !== null ? frozenMs : deadlineEnd - now) / 1000));
    const note = frozenMs !== null ? ' (paused)' : '';
    el.textContent = view.deadline.who === view.you
      ? `Opponent is waiting: ${left} s to end your turn${note}`
      : `Waiting for opponent: ${left} s${note}`;
  }

  // ---------- input ----------
  const closest = (e, selector) => (e && e.target && typeof e.target.closest === 'function' ? e.target.closest(selector) : null);
  // Index stored in a data attribute; -1 when missing (Number(null) would be a valid-looking 0).
  function intAttr(el, name) {
    const raw = el.getAttribute(name);
    return typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : -1;
  }

  function onMapClick(e) {
    if (!view) return;
    const g = closest(e, '.prov');
    if (!g) return deselect();   // a click on empty map: the only way out of "next click marches"
    const i = intAttr(g, 'data-p');
    if (isIdx(i, view.provs.length)) clickProv(i);
  }

  function deselect() {
    if (sel === null) return;
    sel = null;
    draw();
  }

  function clickProv(i) {
    const v = view, army = selectedArmy(v);
    if (canOrder(v) && army && adjacent(v, army.prov, i)) {
      send({ t: 'cmove', army: army.id, to: i });   // the selection stays on the army's province
      return;
    }
    sel = i;
    draw();
  }

  function onPanelClick(e) {
    const b = closest(e, 'button[data-act]');
    if (!b || b.disabled || !view) return;
    const act = b.getAttribute('data-act');
    if (act === 'recruit') recruit(intAttr(b, 'data-i'));
    else if (act === 'cancel') cancelMarch();
    else if (act === 'end') { if (canOrder(view)) send({ t: 'endturn' }); }
    else if (act === 'quit' || act === 'quit-no') { quitArmed = act === 'quit'; quitArmedAt = Date.now(); draw(); }
    else if (act === 'quit-yes') { if (quitArmed && Date.now() - quitArmedAt >= QUIT_GUARD_MS) quit(); }
  }

  // Buttons can be stale by a few milliseconds, so every order is re-checked against the latest view.
  function recruit(i) {
    const v = view, c = v.cost[i];
    if (!c || sel === null || !canOrder(v) || v.owner[sel] !== v.you) return;
    if (v.gold < c.gold || v.units >= v.maxUnits) return;
    send({ t: 'recruit', prov: sel, type: c.type });
  }

  function cancelMarch() {
    const a = selectedArmy(view);
    if (a && canOrder(view) && view.moves.has(a.id)) send({ t: 'cmove', army: a.id, to: null });
  }

  function quit() {
    quitArmed = false;
    draw();
    if (typeof leaveRoom === 'function') leaveRoom();
    else send({ t: 'leave' });
  }

  // ---------- end of campaign ----------
  // Why the campaign ended: the server's endReason when it sends one, else a guess from the map.
  function endReasonText(v) {
    const drawGame = v.winner === -1, won = v.winner === v.you;
    switch (v.endReason) {
      case 'capital': return drawGame ? 'The campaign ended in a draw' : won ? 'The enemy capital has fallen' : 'Your capital has fallen';
      case 'turn_limit': return drawGame ? 'Turn limit reached: equal provinces, a draw' : 'Turn limit reached: the player with more provinces wins';
      case 'both_capitals': return 'Both capitals fell in the same turn';
      case 'fault': return 'The game ended because of a server problem';
      case 'forfeit': return 'Your opponent left';
      default: break;
    }
    // Winner -1 also comes from a server fault, so name a capital only when the map shows it fell.
    const known = v.capital.length === 2;
    const fell = side => known && v.owner[v.capital[side]] === 1 - side;   // side's capital is held by the other
    if (drawGame) return fell(0) && fell(1) ? 'Both capitals fell in the same turn' : 'The campaign ended in a draw';
    if (won) return fell(1 - v.you) ? 'The enemy capital has fallen' : 'The campaign was won';
    return fell(v.you) ? 'Your capital has fallen' : 'The campaign was lost';
  }

  function announceEnd(v) {
    const drawGame = v.winner === -1, won = v.winner === v.you;
    const title = drawGame ? 'CAMPAIGN DRAW' : won ? 'CAMPAIGN VICTORY' : 'CAMPAIGN DEFEAT';
    const sub = `${endReasonText(v)} (turn ${v.turn}).`;
    if (typeof showEndOverlay === 'function') { showEndOverlay(title, sub, { leave: true }); return; }
    // no overlay helper (older client.js): drive the overlay elements directly
    const text = $('endText'), subEl = $('endSub'), btn = $('btnAgain'), box = $('end');
    if (text) text.textContent = title;
    if (subEl) subEl.textContent = sub;
    if (btn) btn.style.display = 'inline-block';
    if (box) box.style.display = 'flex';
  }

  // ---------- public contract (SPEC 8.1) ----------
  // Called for every `camp` message, possibly many times per turn: keeps the selection.
  function renderCamp(m) {
    const v = normalise(m);
    if (!v) return;
    const fresh = view && (v.turn < view.turn || (view.winner !== null && v.winner === null));
    if (fresh) { sel = null; quitArmed = false; lastDl = null; }   // a new campaign started in the same room
    if (sel !== null && sel >= v.provs.length) sel = null;
    carryDeadline(v);
    view = v;
    syncDeadline();
    draw();
    if (v.winner !== null) announceEnd(v);
  }

  // Called when the player leaves the room or a new room starts: forget everything.
  function campaignReset() {
    view = null;
    sel = null;
    quitArmed = false;
    quitArmedAt = 0;
    lastDl = null;
    stopTimer();
    for (const key of ['map', 'panel']) {
      const el = $(key);
      if (el) el.innerHTML = '';
      drawn[key] = null;
    }
  }

  globalThis.renderCamp = renderCamp;
  globalThis.campaignReset = campaignReset;
})();
