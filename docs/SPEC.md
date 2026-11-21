# Legio Online v2 — public-server hardening, reconnects, fair simulation, tests

This document is binding for the v2 change. If something here turns out to be impossible or clearly wrong,
implement the closest sensible behaviour and say so in your report. Do not silently diverge.

## 0. Context and goals

Legio Online runs as ONE always-on Node process (Node >= 20, ESM, only dependency: `ws`) with every room in
memory, behind an HTTPS reverse proxy (Render free tier: about 0.1 CPU and 512 MB, sleeps when idle, any
restart drops all games). v2 makes it fit for the public internet:

1. No remote input (HTTP or WebSocket) may crash the process, corrupt another room, or leave a room stuck.
2. A network blip or page reload does not forfeit a game: seat tokens, a grace period, rejoin.
3. No game hangs forever: battle time limit, turn hurry-up timer, idle-room expiry, generation-guarded timers.
4. The battle simulation is fair (simultaneous resolution) and deterministic (no `Math.random` in game logic).
5. The defects listed in each section are fixed.
6. `npm test` runs an automated suite built on `node:test`. No new dependencies, no build step.

Priorities: **P0** must ship and be correct. **P1** ships only if solid and tested; otherwise leave it out
cleanly and report it. Never ship a half-working P1 item.

Non-goals: accounts, matchmaking, chat, art or sound assets, new unit types, touch controls.

## 1. Tracks and file ownership

| Track   | Owns (may create / edit / delete) |
|---------|-----------------------------------|
| SIM     | `sim.js`, `bot.js` (new), `test/sim.test.mjs`, `test/bot.test.mjs` |
| CAMP    | `campaign.js`, `test/campaign.test.mjs` |
| NET     | `lib/http.js`, `lib/limits.js`, `test/net.test.mjs`, `public/robots.txt` |
| SERVER  | `server.js`, `test/harness.mjs`, `test/run.mjs`, `test/server.*.test.mjs`, `package.json`, `render.yaml`; deletes the old ad-hoc scripts `test/bots.js`, `test/extra.mjs`, `test/campaign.mjs` |
| BCLIENT | `public/client.js`, `public/index.html` |
| CCLIENT | `public/campaign.js` |

`README.md` and `Dockerfile` belong to the integrator. All tracks run at the same time in one checkout:
never touch a file you do not own.

## 2. Wire protocol v2

JSON text frames, one object per frame, at most 4096 bytes. Unknown `t`, wrong field types and
out-of-phase messages are ignored silently: never an exception, never a state change. Room codes are 4
characters `A-Z0-9`, case-insensitive on input.

### 2.1 Client to server

| Message | Meaning |
|---|---|
| `{t:'create', name, mode?}` | Create a room. `mode`: `'battle'` (default) or `'campaign'`. |
| `{t:'practice', name, mode?}` | Create a room whose second seat is the AI. |
| `{t:'join', code, name}` | Join a room that is in phase `lobby` and has a free seat. |
| `{t:'rejoin', code, token}` | Re-attach this socket to a seat (after a reload or a dropped connection). |
| `{t:'leave'}` | Leave the room now (forfeits a running game). Reply: `left`. The socket stays usable. |
| `{t:'ready'}` | Ready up (phases `lobby` and `over`). When both seats are ready the game starts. |
| `{t:'move', ids:[int], x, y, face?}` | All listed regiments march to one point. `face` (radians) is the facing taken on arrival. |
| `{t:'moves', list:[[id, x, y, face?], ...]}` | Up to 20 per-regiment destinations in one frame (formation moves). |
| `{t:'attack', ids:[int], target:int}` | Attack an enemy regiment. |
| `{t:'stop', ids:[int]}` | Clear orders. |
| `{t:'recruit', prov:int, type:string}` | Campaign, orders phase. |
| `{t:'cmove', army:int, to:int\|null}` | Campaign, orders phase. `null` cancels the march. |
| `{t:'endturn'}` | Campaign, orders phase. |
| `{t:'ping', n?}` | Keepalive. Reply `{t:'pong', n}`. Does not count as room activity. |

`name` is sanitised server-side to `[A-Za-z0-9_ -]`, max 16 chars, default `Commander`.

### 2.2 Server to client

| Message | Meaning |
|---|---|
| `{t:'room', code, phase, mode, you, token, players:[{name, ready, bot, connected, grace?}]}` | Room state. `you` = your seat index (0 or 1), `token` = YOUR secret seat token (never another seat's). `connected:false` + `grace` (whole seconds left) while a seat is waiting for a rejoin. Sent whenever seats, ready flags, connectivity or the lobby/over phase change, and first after any successful create / join / rejoin. |
| `{t:'left', reason?}` | You are no longer in a room. `reason`: `'leave'`, `'idle'`, `'closed'`. |
| `{t:'error', msg, code?}` | `code`: `'bad_room'`, `'server_full'`, `'too_many_rooms'`, `'rejoin_failed'`, `'rate'`, `'shutdown'`. `msg` is plain text for the player. `'too_many_rooms'` answers a `create` / `practice` from an address that already owns its share of rooms (7.2): "You already have several games open from this connection. Close one first." `'rate'` is sent for a message over the per-connection budget ("Too many messages. Slow down.") and also answers a `join` from an address that has named too many rooms that do not exist (7.2): "Too many wrong room codes. Wait a minute and try again." |
| `{t:'start', you, W, H, types, limit, startMen}` | A battle begins, or you rejoined one. `limit` = time limit in seconds. `startMen` = object mapping each regiment id (as a string, `"1"`...) to its integer men at the start of this battle, for both sides (the denominator of the unit cards). It is the same object again when the `start` is a resync after a rejoin, whatever the regiments have lost since. |
| `{t:'snap', time, left, regs}` | 20 per second while the battle runs. `left` = whole seconds until the time limit. `regs` = array of `[id, owner, type, x, y, face, men, morale, state, ammo, engagedId]` (layout unchanged from v1). |
| `{t:'end', winner, reason, forfeit?}` | Battle finished, or the whole game ended by forfeit. `winner`: `0`, `1` or `-1` (draw). `reason`: `'rout'`, `'timeout'`, `'forfeit'`. `forfeit:true` exactly when `reason==='forfeit'`. A human who may have missed it is sent it again, once, right after the `room` of its next `rejoin` (7.3); a client therefore has to accept an `end` after a `room`, also when it is already showing that result. `winner` is numbered as the seat is numbered in the `room` that precedes it. |
| `{t:'peer', state, grace?}` | `state:'lost'`: the other seat dropped, game paused, `grace` seconds until they forfeit. `state:'back'`: they returned. |
| `{t:'camp', ...}` | Campaign view, see 7.6. |
| `{t:'pong', n}` | Reply to `ping`. |

### 2.3 Phases

`room.phase`: `lobby` -> (`battle` | `campaign`) -> `over` -> (rematch via `ready`) ...; in a campaign the
room phase is `campaign` during orders/resolution, `battle` during a campaign battle and `between` for the
short gap after a campaign battle. Campaign sub-phase (`camp.phase`): `orders`, `resolving`, `battle`, `over`.

State sync sent to a socket after create / join / rejoin, in this order: `room`; then, on a rejoin only and
only when a result is owed (7.3), `end`; then `camp` if a campaign is in progress; then `start` if a battle is
running (snapshots follow).

## 3. sim.js (SIM track)

Keep it pure and deterministic. Keep these exports: `W`, `H`, `TICK`, `TYPES`, `createBattle`, `giveOrder`,
`step`, `snapshot`, `battleSurvivors`. Add `BATTLE_TIME_LIMIT = 300` (seconds).

```
createBattle(armies?, opts?) -> battle
  armies: [units0, units1], units = [{type, men}]; omitted -> the default quick-battle armies
  opts:   { timeLimit?: seconds (default BATTLE_TIME_LIMIT), defender?: 0 | 1 | null }
battle:   { regs, time, over, winner (0|1|-1|null), reason ('rout'|'timeout'|null), timeLimit, defender }
regiment: { id, owner, type, x, y, face, men (float), maxMen, startMen, morale, ammo, order, state, engaged }
          state: 'idle' | 'moving' | 'fighting' | 'rout' | 'dead'
giveOrder(battle, owner, ids, order)
  order: {t:'stop'} | {t:'move', x, y, face?} | {t:'attack', target}
step(battle)                     advances exactly TICK seconds; no-op once battle.over
snapshot(battle) -> { time, left, regs }      regs layout as in 2.2
battleSurvivors(battle, side) -> [{type, men}]   integers >= 1; routed-but-alive units keep half
```

Required changes:

- **P0 Input validation.** `createBattle` skips units whose `type` is not an own key of `TYPES`
  (`Object.hasOwn`), clamps `men` to an integer in `[1, max]`, keeps at most 20 units per side.
  `giveOrder` ignores non-finite numbers, unknown order kinds, ids that are not the caller's live regiments;
  `face` is used only if finite. Nothing in this module may throw on bad input.
- **P0 Identical default armies.** Both sides of a quick battle get the same list (3 sword, 2 spear,
  2 archer, 2 cav) in mirrored positions.
- **P0 Simultaneous resolution.** Every decision in a tick (targeting, range checks, damage, movement
  direction, facing) is computed from the state at the START of the tick and then applied to all regiments
  together. No regiment may benefit from being earlier in the array. Suggested structure of `step`:
  1. plan: per live regiment pick target, movement intent and attack, reading tick-start state only;
  2. apply damage and morale loss (accumulated per target), ammo use, charge timers, facing;
  3. apply movement (routing regiments flee toward their own edge as today);
  4. separation: accumulate all push vectors from the post-movement positions, then apply them together;
  5. clamp to the field, morale recovery, death, rout;
  6. victory and time limit.
  Consequence to test: a mirror-symmetric battle (identical armies, mirrored orders) stays mirror-symmetric
  within floating-point noise (1e-6), and ends in a draw or mirrored result.
- **P0 Rout threshold uses `startMen`.** A regiment routs when `morale <= 0` or `men < 0.15 * startMen`
  (`startMen` = men at battle start). Morale loss per casualty is normalised by `startMen` (was `maxMen`).
  Defect fixed: a campaign survivor that started a battle below 15% of full strength routed on tick 1.
- **P0 Ranged units out of ammo fight in melee at melee range.** Add `meleeRange: 16` to archers. Defect
  fixed: archers with no ammo dealt melee damage from 182 units away because the shooting range was reused.
- **P0 Time limit.** When `time >= timeLimit` and the battle is not over: `over = true`,
  `reason = 'timeout'`, and the winner follows from the surviving fraction of each side:
  fraction = (men of regiments that are still fighting + half the men of regiments that are routing but
  not yet gone) / total `startMen` of that side. With a `defender` (0 or 1, a campaign battle) the defender
  wins unless its fraction is below 0.75 times the attacker's, in which case the attacker wins (so a
  regiment that merely runs away cannot hold the field against an army that is still whole). Without a
  defender a difference under 0.02 is a draw (`-1`), otherwise the side with the larger fraction wins.
  Normal endings set `reason = 'rout'`. `snapshot().left = max(0, ceil(timeLimit - time))`.
- **P0 Facing on arrival.** A move order with a finite `face` leaves the regiment facing that way when it
  arrives. A regiment with no order that is attacked and is not itself attacking turns to face its nearest
  attacker (flank and rear multipliers use the target's tick-start facing).
- Keep the current feel otherwise: same unit stats (as tuned in `docs/BALANCE.md`; recruit prices sword 100, spear 90, archer 125, cav 145), damage formula, flank (x1.35) and rear (x1.8)
  multipliers, charge bonus, spear anti-cavalry, 20 s rout timer, auto-acquire radius (melee 40, ranged = range).

Tests (`test/sim.test.mjs`): determinism (same inputs -> identical snapshots); mirror symmetry;
no NaN / negative men / out-of-field positions over long random-order fuzzing (use a seeded PRNG inside the
test); every battle ends by the time limit; depleted units do not rout on tick 1; out-of-ammo archers
cannot hurt anything beyond melee range; timeout winner rules; facing on arrival; bad input never throws.

## 4. bot.js (SIM track)

```
export function botThink(battle, side)   // call once per sim tick for an AI-controlled side
```

Issues orders only through `giveOrder`. Deterministic, never throws, keeps its own state in a `WeakMap`
keyed by the battle. Acts every 0.5 s of sim time. Behaviour (keep it simple and robust):

- Infantry (sword, spear): attack the nearest live enemy; spears prefer enemy cavalry within 220, but not
  while any enemy is within 45 of them (a spear in contact keeps fighting whoever is on top of it).
- Archers with ammo: if the nearest enemy is closer than 70, step directly away by about 110 (stay inside
  the field; if cornered, shoot instead); otherwise attack the weakest enemy in range, else the nearest.
  Archers without ammo behave like infantry.
- Cavalry: prefer enemy archers, then enemies already fighting someone else (flank them), then the nearest
  non-spear, then the nearest. Re-target only when idle, when the target is gone, or every 3 s.
- Never order a routing or dead regiment; never target one.

Tests (`test/bot.test.mjs`): bot vs bot battles always finish before the time limit without throwing;
bot beats a passive opponent; determinism.

## 5. campaign.js (CAMP track)

Keep it pure. Keep exports `PROVS`, `CAPITAL`, `EDGES`, `ADJ`, `COST`, `START_GOLD`, `INCOME`, `MAX_UNITS`,
`newCampaign`, `totalUnits`, `recruit`, `setMove`, `resolveMoves`, `applyBattle`, `settle`, `endTurn`,
`aiTurn`. Add `REPLENISH = 0.25` and `regroup(units)`, `TURN_LIMIT = 100` and `MIRROR` (the AI's province mirror map,
below).

- **P0 Validation.** Every mutator validates its arguments (integers in range, own keys only via
  `Object.hasOwn`, ownership) and returns `false` without mutating on bad input; none may throw. Defect
  fixed: `recruit(c, p, prov, 'constructor')` passed the `type in COST` check, set gold to `NaN` and created
  a garbage unit.
- **Return values of the order mutators.** `recruit(...)` is `true` when a unit was recruited. `setMove(c, p,
  armyId, to)` is `true` only when the pending marches actually changed: a new march, another destination,
  or the cancellation of a march that existed. It is `false` for refused input AND for an order that changes
  nothing: `to === null` with nothing pending, or the same destination again. The server sends the campaign
  view only after a call that returned `true`, so a no-op order costs no broadcast.
- **P0 `resolveMoves(c)`** returns battles as `{prov, a0, a1, defender}` where `defender` is the province
  owner before this turn's captures if that is 0 or 1, else `null`.
- **P0 `applyBattle(c, battle, winner, survivors)`**: the loser's army is removed; a draw (`-1`) removes
  both; the winner keeps `regroup(survivors[winner])` (army removed if that is empty).
  `regroup(units)`: per unit type (order sword, spear, archer, cav) pool the men and re-form full-strength
  units plus at most one remainder unit; total men per type is conserved; unknown types dropped.
- **P0 `settle(c)`**: an army alone in a province takes it. Taking the enemy capital wins. If both capitals
  fall in the same turn the campaign is a draw (`winner = -1`). Defect fixed: remove the old rule that
  declared a player with no armies and little gold the loser (they still earn income and can recruit).
- **End reason.** The campaign object has `endReason`, `null` while it runs, and set by whatever ends it:
  `'capital'` (`settle`: one capital taken), `'both_capitals'` (`settle`: both taken in one turn, a draw),
  `'turn_limit'` (`endTurn`, below), `'fault'` (the server ended it as a draw after a fault, 7.2) and
  `'forfeit'` (a seat left a running campaign: recorded on the campaign that is then discarded, so no campaign
  view carries it, 7.3). It is sent to the clients in the campaign view (7.6).
- **P0 `endTurn(c)`**: income as today, then replenishment: every unit of an army standing in a province
  owned by its own player regains `ceil(REPLENISH * max)` men, capped at max; then `turn++`, ready reset,
  log trimmed.
- **Turn limit.** `TURN_LIMIT = 100`. When `endTurn` is called on turn `TURN_LIMIT` (the counter would pass it)
  the campaign ends instead of moving on, with no income and no replenishment: the player who owns more
  provinces wins, equal counts are a draw (`winner = -1`), `endReason = 'turn_limit'`, and the log says so. It
  returns `true`. A caller must look at `winner` after `endTurn`. Without a limit two evenly matched players
  (or two AIs) could trade drawn battles for ever.
- **P1 AI (`aiTurn`)**: recruit at the capital as today. The army at its own capital ("the garrison") holds
  while an enemy army is within 2 steps of that capital, but at most 2 turns in a row; on the third it
  attacks the nearest enemy army (the first step toward it) whatever the odds. It also attacks at once, with
  no waiting, when it has at least 70% of the men of all enemy armies within 2 steps of the capital. After
  such an attack the AI is "on the press" for 3 turns: its armies that stand next to an enemy army attack it
  instead of walking back (strength is not checked), so a sortie cannot turn into a shuffle that never meets
  the enemy. A field army of 5+ units returns toward its capital when the capital is threatened and it is
  closer than the enemy's nearest target (unless on the press). Otherwise as today (8+ units: march on the
  enemy capital; smaller: take the nearest province that is not its own and has no enemy army), but never
  step into a province holding an enemy army with more men than itself unless the AI army has 12+ units.
  An army that was turned back by a crossing last turn waits or attacks again by a deterministic hash of the
  turn, the army id, the AI's own gold and its seat, mixed with murmur3's 32-bit finalizer so that no pattern
  in any of them shows through (not by turn parity, which an opponent could learn and time a counter-march
  against). Deterministic. Never throws. Never leaves the game unable to progress: a passive
  enemy parked two steps from the AI capital is engaged within a few turns, and a lone garrison cannot keep
  a host off its capital for ever. The AI keeps its counters in the campaign object (`c.hold`, `c.press`),
  keyed by turn, so asking for the same turn's orders twice changes nothing.
- **The AI never leaves its capital open.** The garrison does not march out (it holds, which counts toward
  its two held turns) while an enemy army other than the one it would attack stands within one step of the
  capital, because that army would walk into the empty capital and win. This applies to both ways out: the
  immediate attack with 70% of the men and the attack after the two held turns. So a human with two armies
  next to the AI capital cannot lure the garrison out; a single passive army (or one next to the capital
  with another two steps away) is still attacked as before. A garrison that only waits because of the
  bounce rule has not attacked: it counts as a hold and starts no press. While the AI is "on the press" its
  field armies of 5+ units do not walk back to the capital.
- **The AI favours neither seat.** The map is mirror-symmetric: `MIRROR = [12, 9, 10, 11, 7, 8, 6, 4, 5, 1, 2,
  3, 0]` (province `i` is the image of province `MIRROR[i]`) is an involution, a graph automorphism of
  `EDGES` and mirrors the province coordinates (`x -> 1000 - x`). Wherever the AI breaks a tie by the order
  in which it visits the neighbours of a province (its route search), seat 1 visits them in the mirror
  image of seat 0's order, so the orders for a position and for its mirror image (seats swapped, provinces
  mirrored) are mirror images of each other. (A harness that calls `aiTurn(c, 0)` before `aiTurn(c, 1)`
  still gives seat 1 a look at seat 0's fresh recruits; call them in random order when measuring.)

Tests (`test/campaign.test.mjs`): validation incl. prototype keys; bounce; merge; battle list + defender;
regroup conserves men; draw removes both; capture and capital win; double capital capture = draw; income;
replenish only at home and capped; no premature elimination; `setMove` return values; 200-turn AI-vs-AI soak
with battles auto-resolved by a simple strength comparison in the test (no throw, gold never negative or NaN,
unit cap respected); the garrison holds at most 2 turns; a passive enemy two steps from the AI capital is
engaged or something is captured within 8 turns; a lone garrison counter-marching on any fixed pattern cannot
stop an assault for ever; the turn limit and the end reasons; `MIRROR` is a symmetry of the map; the AI's orders
for 4000 random positions and their mirror images are mirror images (paired-mirror method); the bounce wait
has no period and the seats' waits are not complements; the capital is never left open; a waiting garrison
starts no press; a pressed field army does not walk home.

## 6. lib/http.js and lib/limits.js (NET track)

```
// lib/http.js
export function createHttpHandler({ publicDir, getStats, cacheStatic = true, trustProxy = 0, rate = null }) -> (req, res) => void
// lib/limits.js
export function createTokenBucket(capacity, refillPerSec, now = Date.now) -> { take(n = 1): boolean }
export function clientIp(req, trustProxy) -> string      // see below
export function proxyHops(trustProxy) -> number          // false/undefined/0 -> 0, true -> 1, positive integer N -> N, else 0
export function createIpCounter(maxPerIp) -> { add(ip): boolean, remove(ip): void, count(ip): number }
export function createFailureThrottle(max, windowMs, now = Date.now) -> { blocked(key), fail(key), forgive(key), prune(), size() }
export function createKeyedBuckets(capacity, refillPerSec, maxKeys = 10000, now = Date.now) -> { take(key): boolean, size() }
```

`clientIp(req, trustProxy)`: `trustProxy` is `false` (the socket address), `true` (= 1 trusted proxy) or a
positive integer N = the number of proxies of our own in front of the server. With N hops the address is the
N-th entry of `X-Forwarded-For` counted from the RIGHT: every proxy appends the address it received the
connection from, so the entries on the left may be anything the client wrote, and the entry N places from
the right is the first one that was not written by the client. With fewer than N entries, or when that
entry is not an IP address, the socket address is used. No other header (`CF-Connecting-IP`, `X-Real-IP`,
`Forwarded`) is believed. The result is a key, never empty (`'unknown'` at worst), lower-case, without port or
brackets: an IPv4-mapped IPv6 address is the IPv4 address, any other IPv6 address is its /56 prefix as four
hex groups without leading zeros, the fourth masked to its top byte (`2001:db8:1:0` for `2001:db8:1:1::a`), so one
subscriber (who holds a /64, a /56 or more) cannot multiply connections by rotating through its prefix, and the
different spellings of one address are one key.

`createFailureThrottle`: `blocked(key)` is true once `max` failures were recorded less than `windowMs` ago,
until the oldest of them ages out; `forgive(key)` wipes the failures of one key. At most `max` timestamps are
kept per key and at most 10000 keys. The table is kept in order of each key's latest failure, so `fail()` drops
expired keys from the front only (amortised: it never rescans the table) and, when the table is still full,
evicts the oldest key, preferring one that is not blocked; `prune()` drops every expired key and is called from
a timer. A bad configuration blocks (denies) rather than throwing.

`createKeyedBuckets(capacity, refillPerSec, maxKeys)`: one token bucket per key (a client address), for limits on
requests rather than messages. At most `maxKeys` (10000) buckets; when the table is full, buckets that have been
idle long enough to be full again are dropped from the front (kept in order of last use), and then the least
recently used one. Bad configuration denies.

HTTP handler, all P0:

- Never throws and never lets a stream error escape, whatever the request line. Defect fixed: `GET //`
  made `new URL(req.url, base)` throw inside the request handler and killed the process.
- `GET` and `HEAD` only; anything else -> `405` with `Allow: GET, HEAD`.
- Path = request target up to `?`. Must start with `/`. `decodeURIComponent` in try/catch (failure -> `400`).
  Reject NUL bytes and backslashes (`400`). `/` -> `/index.html`. `/healthz` -> `200 text/plain` body `ok`
  (optionally `getStats()` as JSON when `?stats` is asked; never touches the disk).
- Resolve inside `publicDir` only: the normalised absolute path must equal `publicDir + path.sep + rest`
  (a sibling such as `public-old/` must not match). No directory listings. Any path segment starting with
  `.` -> `404`. Regular files only; missing -> `404 text/plain`.
- **Static files are served from memory.** At start-up (when the handler is created) `publicDir` is scanned
  recursively and every regular file is read once (dot-files and dot-directories, names that fail the segment
  rule, symlinks and junctions, files over 8 MiB and everything past 64 MiB in total are skipped). Each entry holds
  the body, its content type, a strong ETag (a hash of the content) and the headers below. A request is a table
  lookup: an unknown path is `404` without touching the disk, and a file that changed or appeared after
  start-up is not seen until the process restarts. `If-None-Match` (a list of tags, `W/` ignored, or `*`) is
  answered `304` with the headers and no body. HEAD works. `cacheStatic: false` reads the file from the disk on
  every request instead (the per-request path rules are unchanged); tests that change files under a running
  server use it, or create their files before the server starts.
- **Request limit.** With `rate = { capacity, refillPerSec }` every request except `GET`/`HEAD /healthz` takes a
  token from a bucket kept per `clientIp(req, trustProxy)`; with none left the answer is `429`, `Retry-After: 1`,
  a short plain-text body, and the usual headers. Without `rate` there is no limit. The game server turns it on
  (40 burst, 20 per second, 7.1).
- Headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `Cache-Control: no-cache`. Text types carry `; charset=utf-8`. Set
  `Content-Length`. Files also carry `ETag`. HTML also gets `Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'`.
- `public/robots.txt`: `User-agent: *` / `Disallow: /`.

Tests (`test/net.test.mjs`): start a bare `http.createServer(createHttpHandler(...))` on port 0 and check
the cases above with raw sockets for malformed request lines (`GET // HTTP/1.1`, `GET /%zz`, absolute-form,
`*`, traversal with `..`, encoded `%2e%2e%2f`, `/..%5c`), plus bucket refill maths and the IP counter.

## 7. server.js (SERVER track)

### 7.1 Shape

```
export function createGameServer(options = {}) -> {
  httpServer,                       // node http.Server, not yet listening
  listen(port = 0, host?) -> Promise<number>,   // resolves with the bound port
  close() -> Promise<void>,         // stops timers, closes sockets and the http server
  stats() -> { rooms, connections },
}
```

Run directly (`node server.js`) it listens on `process.env.PORT || 3000`, logs
`Legio Online listening on http://localhost:<port>`, and installs SIGTERM / SIGINT handlers. Importing the
module must not start anything (main-module guard that also works on Windows:
`import.meta.url === pathToFileURL(process.argv[1]).href`).

Options (all optional; tests shrink the timers):

| Option | Default | Meaning |
|---|---|---|
| `tickMs` | 50 | Real milliseconds between sim steps (sim dt stays `TICK`). |
| `battleTimeLimit` | `BATTLE_TIME_LIMIT` | Seconds of sim time per battle. |
| `betweenMs` | 3500 | Gap after a campaign battle before the campaign continues. |
| `resolveDelayMs` | 1200 | Pause after both turns are in, before the first battle. |
| `graceMs` | 60000 | How long a dropped seat is held (in a running game against another human: the per-seat allowance, 7.3). |
| `graceRefill` | 0.25 | Allowance earned back per millisecond a seat is connected (7.3). |
| `resumeDelayMs` | 1500 | Delay before a paused battle resumes after a rejoin. |
| `hurryMs` | 90000 | Hurry-up timer for the slower campaign player. |
| `heartbeatMs` | 25000 | WebSocket ping interval. |
| `idleRoomMs` | 45 * 60000 | Rooms with no client activity for this long are closed. |
| `unseatedIdleMs` | 5 * 60000 | A socket in no room that sent nothing but `ping` for this long is closed (1008, `Idle`). |
| `maxRooms` | 60 | Rooms in memory (lobbies and games). Chosen from a CPU measurement, see the README. |
| `maxRoomsPerIp` | 4 | Rooms (connected or not) one client address may own at a time (7.2). |
| `lobbyMaxMs` | 15 * 60000 | A lobby with fewer than two humans whose seats have not changed for this long is closed (7.2). |
| `maxConnections` | 500 | |
| `maxPerIp` | 20 (40 behind a proxy) | Connections per client address; a proxy's address may stand for many players. |
| `joinFails` / `joinWindowMs` | 8 / 60000 | Failed joins per address per window before joins are answered `rate` (7.2). |
| `rate` | `{capacity: 60, refillPerSec: 30}` | Per-connection message budget. |
| `httpRate` | `{capacity: 40, refillPerSec: 20}` | HTTP requests per client address, `/healthz` excepted (6, 7.2). |
| `upgradeRate` | `{capacity: 10, refillPerSec: 2}` | WebSocket upgrades per client address (7.2). |
| `allowedOrigins` | `ALLOWED_ORIGINS`, else none | Full origins (array or comma-separated string) besides the server's own that may open a WebSocket (7.2). |
| `cacheStatic` | `true` | Serve the public files from memory (6). |
| `trustProxy` | `TRUST_PROXY_HOPS`, else 1 on Render (`RENDER` set), else 0 | Number of proxies of our own in front of the server (`false` = 0, `true` = 1, an integer N), see 6. |
| `log` | `console.log` | Logger function; tests pass a no-op. |
| `publicDir` | `./public` next to server.js | |

Environment variables (read by `createGameServer` for the options that were not passed, so they also apply
when run directly; an option passed in code always wins; a value that is not a valid integer is ignored):
`TRUST_PROXY_HOPS` (integer >= 0; default 1 when `RENDER` is set, else 0 = off), `MAX_ROOMS`,
`MAX_CONNECTIONS`, `MAX_PER_IP`, `MAX_ROOMS_PER_IP` (positive integers) and `ALLOWED_ORIGINS` (comma-separated full
origins such as `https://example.com`; entries that are not origins are ignored). The first connection that carries an `X-Forwarded-For`
header logs one line with the (bounded, printable-only) header and the client it was counted as, or a
warning when `TRUST_PROXY_HOPS` is 0, so a wrong hop count shows up on the first visit.

### 7.2 Robustness (P0)

- HTTP goes through `createHttpHandler` from `lib/http.js`.
- Every WebSocket message handler call and every room tick runs inside try/catch. A throwing tick ends that
  room's game as a draw for its players (`end` with `winner:-1`), logs once, and never affects other rooms.
  `process.on('uncaughtException' / 'unhandledRejection')` (installed only when run directly) log and keep
  serving.
- **Generation guard.** Each room has `gen`, incremented whenever a game starts, the room resets to the
  lobby, or the room is destroyed. Every `setTimeout` / `setInterval` callback created for a room captures
  the `gen` at creation and returns immediately if it changed. Defects fixed: a player leaving during the
  1.2 s resolve delay or the 3.5 s gap after a campaign battle left timers running against a room whose
  campaign was already cleared (`C.settle(null)` -> uncaught TypeError -> process exit), or started a ghost
  battle in a room that was back in the lobby.
- Limits: `maxPayload` 4096; connection refused (close code 1013) beyond `maxConnections` or `maxPerIp`
  (per client address as `clientIp` computes it, 6); `create` / `practice` beyond `maxRooms` -> `error`
  `server_full`, and beyond `maxRoomsPerIp` rooms of the same address -> `error` `too_many_rooms` (below); per-connection token bucket: a message over budget is dropped, and a connection that has
  more than 200 messages dropped is closed with code 1008.
- **Capacity is never made by destroying somebody's room.** A room is only destroyed by its own timers (grace
  expiry, idle expiry), an explicit leave, or a fault. The room records the address that created it
  (`room.ip`). An address may own at most 4 abandoned rooms (rooms in which no human is connected); when it
  creates or starts a practice room while already owning 4, THAT address's oldest abandoned room is
  destroyed first. Another address's room, and any room with a connected human, is never touched, so a
  reload or a network blip is always covered by the grace period; at `maxRooms` the answer is `server_full`.
- **Rooms per address.** Rooms are counted by `room.ip` whether or not a human is connected. `create` and
  `practice` (campaign rooms too) are refused once the address owns `maxRoomsPerIp` (4) rooms, with `error`
  `too_many_rooms`: "You already have several games open from this connection. Close one first." Before
  refusing, if some of that address's rooms are abandoned, its oldest abandoned one is destroyed and the create
  goes on. So a few addresses cannot pin every room slot with sockets that do nothing. The check comes before the
  `maxRooms` check; another address's room is never evicted.
- **Lobby expiry.** A lobby (phase `lobby`) with fewer than two humans whose seat set has not changed for
  `lobbyMaxMs` (15 minutes) is destroyed with `left` / `reason: 'idle'` however much `ping`, `ready` or other
  traffic it gets (a seat is added by `join`, removed by a leave or grace expiry, and the room reset after a
  game also restarts the clock). Idle expiry (below) stays for everything else.
- **Unseated sockets.** A socket that is in no room (never joined one, or left / was removed from one) and
  sends no message other than `ping` for `unseatedIdleMs` (5 minutes) is closed with code 1008, reason
  `Idle`. Seated sockets are never closed by this; their rooms have idle expiry and the heartbeat.
- **Room-code guessing.** Room codes stay 4 characters. Only a `join` of a code that does not exist counts as a
  failure (a room that exists but is full or already started does not); after 8 failures from one address within
  60 s, further `join` messages from that address are answered with `error` code `rate` ("Too many wrong room
  codes. Wait a minute and try again."), without any room lookup, until fewer than 8 failures remain inside the
  window. A successful `join` clears that address's failures.
- **WebSocket upgrades.** Each upgrade takes a token from a per-address bucket (`upgradeRate`: 10 burst, 2 per
  second; `clientIp` as above). With none left the server writes `HTTP/1.1 429` with `Retry-After: 1` to the raw
  socket and destroys it before any handshake work. Then the `Origin` header is checked: when present, its host
  (including a non-default port) must equal the request's `Host` header, ignoring case, or the origin must be in
  `allowedOrigins`; otherwise the upgrade is refused with `403` and the socket closed. A missing `Origin` is
  allowed (scripts, tests, other non-browser clients); an `Origin` that is not an http(s) origin (`null`,
  garbage, a path, user info) is refused. A page of another site therefore cannot use its visitors' browsers to
  open sockets here. If the platform rewrites the `Host` header, list the public origin in `ALLOWED_ORIGINS`.
- Heartbeat: every `heartbeatMs` ping each socket; a socket that did not answer the previous ping is
  terminated (which then follows the normal seat-lost path).
- Idle expiry: a room with no client message other than `ping` for `idleRoomMs` is closed: its players get
  `left` with `reason:'idle'`.
- Graceful shutdown (`close()`, and SIGTERM / SIGINT when run directly): send every socket
  `{t:'error', code:'shutdown', msg:'The server is restarting. Reload in a minute.'}`, close sockets, stop
  all timers, close the HTTP server; exit within 3 s when run directly.
- Input: validate every field's type before use. `ids` = array of integers, at most 20. `moves.list` = at
  most 20 entries of `[int, number, number, number?]`. Campaign `prov`, `army`, `to` must be integers
  (`to` may be `null`); `type` must be a string. Never coerce with `| 0` (which turned garbage into
  province 0).

### 7.3 Seats, tokens, grace, rejoin (P1, but the uniform seat model below is the design; if you must cut
scope, keep tokens + grace + rejoin for running games)

- A seat = `{name, token, ws | null, ready, bot, lostAt, grace, owedEnd, ...}`. `token` = 16+ random bytes
  (`crypto.randomBytes`), base64url, sent only to its owner inside `room`.
- Socket closes (any phase): the seat stays, `ws = null`, a grace timer starts (`graceMs`, or what is left of
  the seat's allowance in a running game against another human, see below), the other
  human gets `peer` `lost` and a fresh `room`. While any human seat of a room is lost the room is PAUSED:
  no sim steps, no snapshots, no hurry-timer expiry. Timers that fire while paused must not skip work:
  a campaign battle that becomes due simply starts paused.
- `rejoin {code, token}`: if the room exists and the token matches a seat, attach this socket (if the seat
  still has an older live socket, detach and close that one with code 4000 first, without triggering the
  seat-lost path), cancel the grace timer, send the state sync of 2.3, tell the other human `peer` `back`
  plus a fresh `room`. When no seat is lost any more the room un-pauses after `resumeDelayMs`.
  Failure -> `error` with `code:'rejoin_failed'`, `msg:'That game is no longer available.'`.
- Grace expiry or explicit `leave` = the seat is removed. In a running game (phases `battle`, `campaign`,
  `between`) that is a forfeit: the remaining human gets `{t:'end', winner:<their seat>, reason:'forfeit',
  forfeit:true}`, the game is discarded (`gen++`), bot seats are dropped, the room returns to `lobby` with
  the remaining human in seat 0 (send them a fresh `room`), exactly as v1 did. A room with no human seat
  left is destroyed. In `lobby` / `over` the seat is just removed and the room re-broadcast.
- **Grace is an allowance in a running game against another human.** In phases `battle`, `campaign` and
  `between` of a room with two human seats, `graceMs` is not a fresh timer per drop but a per-seat allowance:
  a drop is held for what is left of it (`peer` `lost` carries that, in whole seconds), time away plus the
  resume delay it causes is spent when the seat returns, and the allowance refills at `graceRefill` (0.25) per
  millisecond connected (60 s back per 4 minutes), never beyond `graceMs`. So dropping again and again cannot
  freeze the other player's game for ever, while a single reload or blip always gets the full allowance.
  Everywhere else nobody is kept waiting and every drop gets the full `graceMs` at no cost: in the lobby and
  on the result screen, and in a practice room (the other seat is the AI), however often the link drops.
- **A result the seat may have missed is owed.** When a quick battle ends (or an aborted one is ended as a
  draw) every human seat is owed the `end` message; when the other player forfeits while a seat is away, that
  seat is owed `{t:'end', winner:<its seat as numbered after the reset: 0>, reason:'forfeit', forfeit:true}`.
  A socket can die without the server noticing for a while, so "away" includes a seat that is still counted
  as connected when the result goes out: for a forfeit the debt is recorded for the staying seat in every case,
  and the `end` is still sent live when it has a socket. The owed message is sent once, immediately after the `room` of the
  next `rejoin` (state sync, 2.3), and the debt is cleared when it is sent, when the seat sends `ready` for the
  rematch, and when the next game starts or the room resets to the lobby. A reload on the result screen
  therefore shows the result again, once. Campaign results are not owed this way: they are in the `camp` view
  (`winner`, `phase:'over'`, the log).
- `leave` replies `{t:'left', reason:'leave'}` and clears the socket's room so it can create or join again.
- A socket that is already seated ignores `create` / `practice` / `join` / `rejoin`.

### 7.4 Lobby and quick battles (P0)

As v1: `create` / `practice` / `join` / `ready`; both ready -> `startBattle`. Quick battle: default armies,
no defender. A side whose seat is a bot is driven by `botThink(battle, side)` from `bot.js` every tick.
Battle loop every `tickMs` (skipped while paused): `step`, bot, broadcast `snap`; when `battle.over` send
`end` with `winner` and `battle.reason`. After a quick battle the room is `over`; bots are ready
automatically; `ready` from both humans starts a rematch. `join` is refused (`bad_room`) unless the room is
in `lobby` with a free seat. Battle orders (`move`, `moves`, `attack`, `stop`) are accepted only in phase
`battle` and only for the sender's own side.

### 7.5 Campaign flow (P0 unless marked)

- Both ready in a campaign room -> `C.newCampaign()`, sub-phase `orders`; bots play `C.aiTurn` and are ready.
- Orders phase: `recruit`, `cmove`, `endturn` from a player who has not ended their turn. Any accepted
  order re-sends `camp` to both.
- **P1 Hurry-up timer:** when exactly one HUMAN has ended their turn and the other human has not, a
  `hurryMs` countdown starts (re-sent in `camp.deadline`); on expiry the slow player's turn is ended for
  them with the orders given so far. Not used against bots. Does not expire while the room is paused.
- Both ended -> sub-phase `resolving`: `C.resolveMoves`, send `camp`, wait `resolveDelayMs`, then fight the
  battles one at a time: sub-phase `battle`, `startBattle(room, [unitsA0, unitsA1], {defender})`, `end`,
  phase `between` for `betweenMs`, `C.applyBattle` with `battleSurvivors`, next battle. Then `C.settle`;
  if `camp.winner !== null` -> phase `over` (send `camp`, then `room`; bots ready); else `C.endTurn`,
  sub-phase `orders`, bots play, send `camp`.
- Every timer in this flow is generation-guarded (7.2).

### 7.6 Campaign view

```
{ t:'camp', you, turn, phase, winner,          // winner: null | 0 | 1 | -1
  gold, income, units, maxUnits, cost, types,  // income = gold per owned province per turn; types = sim TYPES
  replenish,                                   // C.REPLENISH
  provs, edges, capital, owner,
  armies:[{id, owner, prov, units:[{type, men}]}],
  moves,                                       // YOUR pending marches {armyId: provinceIndex}
  ready:[bool, bool], log:[last 8 strings], opponent,
  deadline: null | { who, left },              // seat that must end its turn, whole seconds left
  turnLimit,                                   // integer: C.TURN_LIMIT (100); the campaign ends when turn `turnLimit` is over
  endReason }                                  // null while it runs, else 'capital' | 'both_capitals' | 'turn_limit' | 'fault' | 'forfeit'
```

At the turn limit the campaign ends (5): `winner` is the player with more provinces, or `-1`, `phase` is `over`,
`endReason` is `'turn_limit'`. `endReason` is set exactly when `winner` is not `null`. `'forfeit'` is recorded on the
campaign when a seat leaves a running campaign, but that campaign is discarded at once, so no `camp` message carries
it; the staying player is told by `end` (7.3).

Never send one player's pending `moves` or `gold` to the other.

### 7.7 Tests

`test/harness.mjs`: `startTestServer(options)` (in-process `createGameServer` on port 0 with fast timers
and a silent logger; returns `{port, wsUrl, httpUrl, game, close()}`) and `connect(wsUrl)` (returns a client
with `send(obj)`, `sendRaw(string)`, `next(predicate, timeoutMs)` that consumes messages in order,
`msgs`, `close()`, `closed` promise). `test/run.mjs` finds `test/*.test.mjs` and runs them with
`node --test` (works on Node 20+ and Windows); `npm test` calls it.

`test/server.*.test.mjs` must cover: lobby (create / join / full / bad code / name sanitising); quick
battle end to end with fast ticks, same winner for both, rematch; practice battle; hostile input (garbage,
wrong types, prototype keys, NaN / Infinity / huge numbers, other side's units, oversized frames) with the
server still healthy afterwards; rate limit; `maxRooms`; disconnect in lobby; disconnect in battle ->
pause (sim time frozen) -> rejoin -> resume; grace expiry -> forfeit; wrong token; explicit leave; campaign
vs AI to completion; two-human campaign with a forced battle and correct survivors; hurry-up timer;
rejoin during campaign orders keeps orders; regression for both zombie-timer defects (leave during
`resolving` and during `between`: no crash, no ghost battle, server still answers); battle timeout
(`battleTimeLimit` small, passive players -> `end` `timeout`); heartbeat terminates a dead socket;
`close()` resolves and nothing keeps the event loop alive. The whole suite should finish in under ~90 s.

`package.json`: `"start": "node server.js"`, `"test": "node test/run.mjs"`, engines `>=20`.
`render.yaml`: `healthCheckPath: /healthz`.

## 8. Browser client: public/client.js + public/index.html (BCLIENT track)

Classic scripts, no modules, no inline `<script>` (CSP: `script-src 'self'`); inline styles are allowed.
Never put untrusted text into `innerHTML` without escaping.

### 8.1 Contract shared with public/campaign.js

`client.js` loads first and defines these top-level names, which `campaign.js` may use:
`$(id)`, `send(obj)`, `leaveRoom()`, `escapeHtml(text)`, `showEndOverlay(title, sub, {leave})`
(`leave:true` shows the "Return to lobby" button), and `mySeat()` (returns 0 or 1).
`campaign.js` defines `renderCamp(m)` (called by `client.js` for every `camp` message) and
`campaignReset()` (called when the player leaves a room or a new room starts).
`index.html` keeps these elements: `#camp` containing `svg#map` and `div#panel`; `#end` with `#endText`,
`#endSub` and `#btnAgain`; a `#banner` element (fixed, top centre) for connection and peer notices.

### 8.2 Connection (P0)

- One connection manager around `WebSocket`: on an unexpected close show the banner
  "Connection lost. Reconnecting..." and retry (1 s, 2 s, 3 s, then every 3 s, for up to 75 s); on open,
  if a seat `{code, token}` is stored in `sessionStorage` (`legio.seat`, saved from every `room` message)
  send `rejoin`, otherwise show the menu. After 75 s show "Could not reconnect" with a Reload button.
- On first load, if the socket has not opened after 3 s, show "Waking the server. This can take up to a
  minute on free hosting."
- `error` with `code:'rejoin_failed'`, and `left`: clear the stored seat, call `campaignReset()`, show the
  menu (with the message). `error` with `code:'shutdown'`: banner, then the normal reconnect loop.
- Keepalive: `{t:'ping'}` every 20 s; additionally `fetch('/healthz')` every 4 minutes while seated in a
  room (keeps free hosting awake during a game).
- Opponent connectivity: from `peer` messages and from `room.players[other].connected` show / hide the
  banner "Opponent disconnected. Waiting up to N s" with a live countdown.

### 8.3 Screens (P0)

Screens: menu, room, campaign, battle. `room` messages only update the room view and stored seat; they
never hide a running battle or campaign (they switch menu -> room). `camp` -> campaign screen (and hides
the battle and the battle result overlay unless the campaign itself is over). `start` -> battle screen.
`end` -> result overlay over the battle: VICTORY / DEFEAT / DRAW plus a sub-line from `reason`
("The enemy army broke", "Time expired", "Your opponent left"); in a campaign battle that was not a forfeit
there is no button (the campaign continues by itself after a few seconds); otherwise show "Return to
lobby", which returns to the room view (the room is still joined, ready up for a rematch).
Add a "Leave room" button in the room view and a small "Quit" button during battles and campaigns
(confirm first: quitting forfeits); both call `leaveRoom()` which sends `leave`.

### 8.4 Battle controls and HUD

- **P0** Right-click resolves enemies first (an enemy within the hit radius wins over a nearer friendly).
- **P0** Right-click on ground with several regiments selected = formation-preserving move: each regiment
  keeps its offset from the group's centroid (targets clamped to the field), sent as one `moves` frame.
- **P1** Right-button drag (more than 30 world units) = form a line: selected regiments are spread evenly
  along the dragged segment (ordered by their current position along it) and face perpendicular to it,
  toward the side where the enemy centroid lies; draw the preview while dragging.
- **P0** Keys, case-insensitive: `A` or `Ctrl+A` select all, `S` stop, `Esc` deselect, `1`-`4` select all
  swords / spears / archers / cavalry, `H` or `?` help. Ignore keys while typing in an input.
- **P0** HUD: men and unit counts for both sides, battle clock from `snap.left` (mm:ss, red under 30 s),
  your colour and side.
- **P1** Unit cards along the bottom: one card per own regiment (type glyph and name, men / start men
  with the start men taken from `start.startMen`, morale bar, greyed when routing or dead); click selects, shift-click adds, double-click selects all of
  that type; selected cards are highlighted.
- **P1** Help overlay listing the controls and the unit match-ups (spears stop cavalry; cavalry runs down
  archers and wins on flanks and rear; archers wear spears down; swords are the all-rounder, good against
  archers and cavalry and weaker than spears; rear attacks break morale), and stating
  that a battle ends at the time limit (in a campaign the defender holds unless it has lost clearly more than
  the attacker, below 0.75 of the attacker's surviving share; otherwise the side with more of its army left
  wins, and near-equal is a draw).
- Show routing units distinctly (white flag or faded) and a small facing tick on selected regiments.
- A data-URI favicon in `index.html` (avoids a 404).

Self-check: `node --check public/client.js`; trace every message of 2.2 against your handlers.

## 9. Campaign client: public/campaign.js (CCLIENT track)

Uses only the 8.1 contract. Styles it needs beyond the existing ones go in a `<style>` element it injects.

- **P0** `renderCamp(m)` for the 7.6 view: map, armies, pending marches, province panel with recruit
  buttons (cost, disabled when unaffordable or at the unit cap), unit lists as `men / max` using `m.types`,
  income from `m.income`, log.
- **P0** Draw as well as win / lose: when `m.winner !== null` call
  `showEndOverlay('CAMPAIGN VICTORY' | 'CAMPAIGN DEFEAT' | 'CAMPAIGN DRAW', sub, {leave:true})`.
- **P0** `campaignReset()` clears the selection and cached view; also clear the selection when a new
  campaign starts (turn 1 after a later turn).
- **P0** Deadline: when `m.deadline` is set show "Opponent is waiting: N s to end your turn" (or
  "Waiting for opponent: N s") with a live countdown; never let it go below 0.
- **P0** A "Quit campaign" button (confirm) calling `leaveRoom()`.
- **P1** A short rules box: units regain 25% strength per turn in friendly provinces; survivors regroup
  after a battle; the province owner defends, and the defender holds if a battle runs out of time unless it has lost clearly
  more than the attacker; armies
  that cross paths turn back; take the enemy capital to win.
- Escape every string that comes from the server with `escapeHtml` before using `innerHTML`.

Self-check: `node --check public/campaign.js`.

## 10. Verification before you report

Run your own tests, `node --check` on every file you touched, and re-read your diff once as a hostile
reviewer looking for: unhandled exceptions, timers without a generation guard, unvalidated input, state
that survives a room reset, and anything that differs from this spec.
