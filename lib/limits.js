// Small abuse limits for the public server: a token bucket per connection, the
// client address behind a proxy, and a connections-per-address counter.
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

// '1.2.3.4', '1.2.3.4:5678', '[::1]:5678', '::ffff:1.2.3.4' -> one canonical
// spelling per address, or '' when the text is not an IP address at all.
function normaliseIp(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  if (s.length > 64) return '';
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  return net.isIP(s) ? s : '';
}

function forwardedHop(req, trustProxy) {
  const header = req?.headers?.['x-forwarded-for'];
  const hops = String(Array.isArray(header) ? header.join(',') : header ?? '').split(',');
  // true = first hop (SPEC). An integer N = Nth hop from the right, i.e. the
  // address added by the outermost of N trusted proxies, which a client cannot forge.
  if (trustProxy === true) return hops[0];
  return Number.isInteger(trustProxy) && trustProxy > 0 ? hops[hops.length - trustProxy] : '';
}

// Always returns a string. Text that is not an IP address is never returned,
// so a forged header cannot inject arbitrary keys or log content.
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = normaliseIp(forwardedHop(req, trustProxy));
    if (forwarded) return forwarded;
  }
  return normaliseIp(req?.socket?.remoteAddress) || 'unknown';
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
