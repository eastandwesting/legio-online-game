// Validation of everything a WebSocket client can send. Pure functions: each
// returns a clean value or null, and none of them throws, whatever the input.

export const MAX_FRAME = 4096;   // bytes per frame (SPEC 2)
export const MAX_IDS = 20;       // regiments per order, and entries per 'moves' frame

const isInt = Number.isInteger;
const isNum = Number.isFinite;   // false for strings, NaN and +-Infinity

// A parsed frame must be a plain object with a string 't'.
export function parseFrame(data, isBinary) {
  if (isBinary) return null;
  let m;
  try { m = JSON.parse(data.toString('utf8')); } catch { return null; }
  if (m === null || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return null;
  return m;
}

// [A-Za-z0-9_ -], at most 16 characters; anything unusable becomes 'Commander'.
export function cleanName(name) {
  if (typeof name !== 'string') return 'Commander';
  return name.slice(0, 256).replace(/[^A-Za-z0-9_ -]/g, '').trim().slice(0, 16).trim() || 'Commander';
}

// Room code as typed by a player: null for a non-string, '' for a string that
// cannot be a code (so the lookup simply misses), else 4 upper-case characters.
export function cleanCode(code) {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(c) ? c : '';
}

export function cleanIds(ids) {
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every(isInt)) return null;
  return ids;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// {t:'move'} order for the sim, or null. 'face' is optional; when present it
// must be a finite number and is normalised to (-PI, PI].
function moveOrder(x, y, face, W, H) {
  if (!isNum(x) || !isNum(y)) return null;
  const order = { t: 'move', x: clamp(x, 0, W), y: clamp(y, 0, H) };
  if (face === undefined || face === null) return order;
  if (!isNum(face)) return null;
  order.face = Math.atan2(Math.sin(face), Math.cos(face));
  return order;
}

function movesOrders(list, W, H) {
  if (!Array.isArray(list) || list.length > MAX_IDS) return null;
  const out = [];
  for (const e of list) {
    if (!Array.isArray(e) || e.length < 3 || e.length > 4 || !isInt(e[0])) return null;
    const order = moveOrder(e[1], e[2], e[3], W, H);
    if (!order) return null;
    out.push({ ids: [e[0]], order });
  }
  return out;
}

// A battle message -> list of {ids, order} for giveOrder, or null when any
// field has the wrong type (the whole frame is then ignored).
export function battleOrders(m, W, H) {
  if (m.t === 'moves') return movesOrders(m.list, W, H);
  const ids = cleanIds(m.ids);
  if (!ids) return null;
  if (m.t === 'stop') return [{ ids, order: { t: 'stop' } }];
  if (m.t === 'attack') return isInt(m.target) ? [{ ids, order: { t: 'attack', target: m.target } }] : null;
  if (m.t === 'move') {
    const order = moveOrder(m.x, m.y, m.face, W, H);
    return order ? [{ ids, order }] : null;
  }
  return null;
}

// A campaign order with checked field types, or null. Ranges, ownership and
// unit types are checked by campaign.js.
export function campaignOrder(m) {
  if (m.t === 'endturn') return { t: 'endturn' };
  if (m.t === 'recruit') return isInt(m.prov) && typeof m.type === 'string' ? { t: 'recruit', prov: m.prov, type: m.type } : null;
  if (m.t === 'cmove') {
    const toOk = m.to === null || isInt(m.to);
    return isInt(m.army) && toOk ? { t: 'cmove', army: m.army, to: m.to } : null;
  }
  return null;
}

// Options: a finite number >= min, else the default.
export function numberOption(value, fallback, min = 0) {
  return isNum(value) && value >= min ? value : fallback;
}

// ---------- WebSocket Origin (SPEC 7.2) ----------

// { origin, host } of a browser Origin value ('https://example.com', 'http://localhost:3000'), or null for
// anything else ('null', garbage, other schemes, userinfo, a path). host keeps a non-default port and is
// lower-case, like a Host header.
function parseOrigin(text) {
  if (typeof text !== 'string' || text.length > 256) return null;
  let u;
  try { u = new URL(text.trim()); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.host || u.username || u.password ||
    u.pathname !== '/' || u.search || u.hash) return null;
  return { origin: u.origin, host: u.host };
}

// ALLOWED_ORIGINS: an array or a comma-separated string of full origins -> Set of normalised origins.
// Entries that are not origins are ignored.
export function parseOrigins(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out = new Set();
  for (const entry of list) {
    const o = parseOrigin(entry);
    if (o) out.add(o.origin);
  }
  return out;
}

// May a WebSocket upgrade with this Origin and Host header proceed? No Origin header: yes (scripts and
// tests are not browsers). Otherwise the Origin must be listed, or its host (with port) must equal the
// Host header, ignoring case. A malformed Origin is refused.
export function originAllowed(origin, host, allowed) {
  if (origin === undefined) return true;
  const o = parseOrigin(origin);
  if (!o) return false;
  if (allowed && allowed.has(o.origin)) return true;
  return typeof host === 'string' && host.trim().toLowerCase() === o.host;
}
