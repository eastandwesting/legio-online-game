// Small abuse limits for the public server: a token bucket per connection, the
// client address behind a proxy, a connections-per-address counter and a failure throttle.
// Nothing in this module throws: it runs inside connection handlers.
import net from 'node:net';

// Bad configuration becomes 0 (deny everything), which is loud, not silent.
function nonNegative(value) {
  const n = Number(value);
  return n >= 0 ? n : 0;
}

// Starts full. Refill is computed from elapsed time on each take, so no timer.
export function createTokenBucket(capacity, refillPerSec, now = Date.now) {
  const cap = nonNegative(capacity);
  const rate = nonNegative(refillPerSec);
  const clock = typeof now === 'function' ? now : Date.now;
  let tokens = cap;
  let last = Number(clock());

  function refill() {
    const t = Number(clock());
    if (t > last) tokens = Math.min(cap, tokens + ((t - last) / 1000) * rate);
    // Follow a clock that stepped backwards (or refill would stall); ignore NaN.
    if (!Number.isNaN(t)) last = t;
  }

  return {
    take(n = 1) {
      refill();
      const cost = Number(n);
      if (!(cost >= 0) || tokens < cost) return false;
      tokens -= cost;
      return true;
    },
  };
}

// Eight 16-bit groups of an IPv6 address (any spelling, optional zone and dotted-IPv4 tail), or null.
function ipv6Groups(text) {
  let s = text;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (net.isIP(s) !== 6) return null;
  const dot = s.lastIndexOf('.');
  if (dot >= 0) {                       // '::ffff:1.2.3.4': the IPv4 tail is the last two groups
    const colon = s.lastIndexOf(':');
    const q = s.slice(colon + 1).split('.').map(Number);
    s = `${s.slice(0, colon + 1)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  const fill = halves.length > 1 && missing > 0 ? new Array(missing).fill('0') : [];
  const groups = [...head, ...fill, ...tail].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(Number.isInteger) ? groups : null;
}

// '1.2.3.4', '1.2.3.4:5678', '[::1]:5678', '::ffff:1.2.3.4' -> one canonical key per client, or '' when
// the text is not an IP address at all. IPv4-mapped IPv6 is the IPv4 address; any other IPv6 address is
// keyed by its /64 prefix (one subscriber can rotate through a whole /64, so that is the unit to count),
// written as four hex groups without leading zeros: '2001:db8:1:1'.
function normaliseIp(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  if (s.length > 64) return '';
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  if (net.isIPv4(s)) return s;
  const g = ipv6Groups(s);
  if (!g) return '';
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return g.slice(0, 4).map(x => x.toString(16)).join(':');
}

// How many proxies of our own stand in front of the server: false / undefined / 0 = none, true = 1,
// a positive integer = that many; anything else is treated as none.
export function proxyHops(trustProxy) {
  if (trustProxy === true) return 1;
  return Number.isInteger(trustProxy) && trustProxy > 0 ? trustProxy : 0;
}

// Each proxy appends the address it received the connection from to X-Forwarded-For, so the entries
// at the left may be whatever the client wrote. With N trusted proxies the entry N places from the
// right is the one the outermost of them saw: the only entry a client cannot forge.
function forwardedHop(req, hops) {
  const header = req?.headers?.['x-forwarded-for'];
  const entries = String(Array.isArray(header) ? header.join(',') : header ?? '').split(',');
  return entries.length >= hops ? entries[entries.length - hops] : '';
}

// Always returns a non-empty string. Text that is not an IP address is never returned, so a forged
// header cannot inject arbitrary keys or log content. A missing, short or malformed header gives the
// socket address.
export function clientIp(req, trustProxy) {
  const hops = proxyHops(trustProxy);
  if (hops) {
    const forwarded = normaliseIp(forwardedHop(req, hops));
    if (forwarded) return forwarded;
  }
  return normaliseIp(req?.socket?.remoteAddress) || 'unknown';
}

// Failures per key inside a sliding window: blocked(key) is true once `max` failures happened less than
// windowMs ago, until the oldest of them ages out. Memory is bounded: at most `max` timestamps per key,
// and the number of keys is capped (the oldest key goes first). prune() drops expired keys.
export function createFailureThrottle(max, windowMs, now = Date.now) {
  const limit = nonNegative(max), span = nonNegative(windowMs);
  const clock = typeof now === 'function' ? now : Date.now;
  const hits = new Map();   // key -> ascending timestamps
  const MAX_KEYS = 10000;

  function recent(key) {
    const list = hits.get(key);
    if (!list) return null;
    const cutoff = Number(clock()) - span;
    while (list.length && list[0] <= cutoff) list.shift();
    if (list.length) return list;
    hits.delete(key);
    return null;
  }

  function prune() {
    for (const k of [...hits.keys()]) recent(k);
  }

  return {
    blocked(key) {
      if (limit === 0) return true;     // bad configuration denies
      const list = recent(String(key));
      return !!list && list.length >= limit;
    },
    fail(key) {
      const k = String(key);
      let list = recent(k);
      if (!list) {
        if (hits.size >= MAX_KEYS) {
          prune();
          if (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value);
        }
        list = [];
        hits.set(k, list);
      }
      list.push(Number(clock()));
      if (list.length > limit) list.shift();
    },
    prune,
    size: () => hits.size,
  };
}

// Live connections per address. Entries are deleted at zero, so the map is
// bounded by the number of open connections.
export function createIpCounter(maxPerIp) {
  const max = nonNegative(maxPerIp);
  const counts = new Map(); // a Map, so '__proto__' and friends are plain keys

  return {
    add(ip) {
      const key = String(ip);
      const n = counts.get(key) || 0;
      if (n >= max) return false;
      counts.set(key, n + 1);
      return true;
    },
    remove(ip) {
      const key = String(ip);
      const n = counts.get(key) || 0;
      if (n <= 1) counts.delete(key);
      else counts.set(key, n - 1);
    },
    count(ip) {
      return counts.get(String(ip)) || 0;
    },
  };
}
