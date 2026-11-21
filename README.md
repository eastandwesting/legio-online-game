# Legio Online

An original ancient-world strategy game for two players in the browser: real-time battles and a
turn-based campaign map. Nothing here is taken from, or affiliated with, any commercial title. The
factions, units and rules are invented for this project.

**Play it:** https://legio-online.onrender.com (free hosting: after a quiet spell the first visit can take
about a minute while the server wakes up).

## Run it

```
npm install
npm start          # http://localhost:3000   (set PORT to change)
npm test           # unit and end-to-end suite, about 15 seconds
```

Needs Node 20 or newer. The only dependency is `ws`.

## Play

- **Create Battle / Create Campaign** gives you a four-letter room code; a friend enters it under
  **Join**. Both click **Ready**. **Practice vs AI** and **Campaign vs AI** need no friend.
- Reloading the page or losing your connection does not forfeit: the page reconnects and takes its
  seat back. A dropped opponent pauses the game; they get a grace period, then forfeit.

### Battle controls

| Input | Action |
|---|---|
| Left-click / drag | Select regiments |
| Right-click ground | March there (a group keeps its shape) |
| Right-drag | Form a line along the drag |
| Right-click enemy | Attack it |
| `A`, `1`-`4` | Select all, or all swords / spears / archers / cavalry |
| `S` / `Esc` | Stop / deselect |
| `H` | Help |

### Battle rules

- Units: shortsword infantry, spear phalanx (stops cavalry), archers (limited arrows), heavy cavalry
  (charge bonus; runs down archers).
- Hits from the flank hurt more, hits from behind most of all, and they break morale. A regiment that
  loses its nerve routs and leaves the field.
- Both sides are resolved at the same instant each tick, so neither side has an edge from ordering.
- A battle ends when one army routs, or at the 5-minute limit. At the limit each side's share is what is
  left of its starting men (a routing regiment counts for half). In a quick battle the larger share wins and
  a gap under 2 points is a draw. In a campaign battle the defender holds unless its share is below
  three quarters of the attacker's, so running away from a whole army does not win.

### Campaign rules

- 13 provinces. Each owned province pays 40 gold per turn; recruit units in provinces you own.
  Maximum 16 units per player.
- Both players give orders at once, then end the turn. Armies that meet in a province fight a live
  battle; armies that try to swap provinces turn back.
- Winners keep their survivors, regrouped into full-strength units. Units standing in your own
  provinces regain 25% of their strength each turn.
- The province owner is the defender. If a battle runs out of time the defender holds, unless it has lost
  clearly more of its army than the attacker (see above). The loser's army is removed. Take the enemy
  capital to win; both capitals falling in one turn is a draw.
- If one human ends their turn and the other stalls, a 90-second hurry-up timer ends it for them.
- The campaign lasts at most 100 turns. When turn 100 ends, the player who owns more provinces wins; equal
  counts are a draw. (The campaign view the server sends carries `turnLimit` and, once it is over, `endReason`:
  `capital`, `both_capitals`, `turn_limit`, `fault` or `forfeit`.)
- The AI opponent never marches its capital garrison out while a second army of yours stands next to the
  capital, and it plays Red and Blue alike (its route choices are mirror images of each other).

## Layout

| Path | What |
|---|---|
| `server.js` | Rooms, seats, timers, WebSocket protocol; `createGameServer()` is also what the tests use |
| `sim.js`, `bot.js` | Battle simulation (pure, deterministic) and the AI that drives practice opponents |
| `campaign.js` | Campaign rules and AI (pure) |
| `lib/` | HTTP static handler, rate limiting, input validation |
| `public/` | Browser client (no build step) |
| `docs/SPEC.md` | Wire protocol and behaviour the code is held to |
| `test/` | `node:test` suites; `npm test` runs them all |

## Deploy

The server keeps every room in one process's memory, so it needs a host that runs **one always-on
Node process** and keeps WebSocket connections open. Do not use serverless functions: two players could
land on different instances and never meet.

- **Render**: `render.yaml` is a ready blueprint (free plan, health check `/healthz`). New > Blueprint,
  pick the repository, or open https://render.com/deploy?repo=https://github.com/eastandwesting/legio-online-game
  for a one-click deploy of your own copy. Checked on the live service: Render passes the client-supplied
  `X-Forwarded-For` through and appends the real client address, so the app sees `<anything>,<real client>` and
  the default of 1 hop is correct.
- **Anything with Docker** (Fly.io, Railway, a VPS): use the `Dockerfile`; it listens on `PORT`.
- **Behind a proxy, set `TRUST_PROXY_HOPS`** to the number of proxies in front of the app (1 on Render, where it
  is the default; 0 = none, the default everywhere else). The per-address limits count players by their
  address (an IPv6 client by its /56 prefix), and behind a proxy the socket address is the proxy's. With N hops the address is taken from the
  N-th entry of `X-Forwarded-For` counted from the right. Each proxy appends the address it received the
  connection from to that header, so the entries on the left are whatever the client wrote and can be
  forged one per connection; the rightmost entries were added by your own proxies and can be trusted.
  Set it too low and a client can pick its own address (limits bypassed); set it too high (or when no proxy
  is there) and every player shares one address or the proxy's, and the 20-per-address cap hits real players.
  The first proxied connection logs a line showing the header and the client it was counted as: check it
  once after deploying and raise or lower `TRUST_PROXY_HOPS` until each player shows up as their own
  address. Only the `X-Forwarded-For` header is used.

Things to expect on a free tier: the service sleeps when idle (first visit can take about a minute) and
any restart drops games in progress. `GET /healthz` returns `ok`; `GET /healthz?stats` adds room and
connection counts.

Limits (options of `createGameServer`; environment variables override the defaults, and a value that is not
a positive integer is ignored):

| Limit | Default | Environment |
|---|---|---|
| Rooms (lobbies and games) | 60 | `MAX_ROOMS` |
| Connections | 500 | `MAX_CONNECTIONS` |
| Connections per address | 20 (40 behind a proxy: a proxy address can stand for many players) | `MAX_PER_IP` |
| Rooms per address (connected or not) | 4: a fifth `create` / `practice` gives up that address's own oldest abandoned room, or is answered `too_many_rooms` | `MAX_ROOMS_PER_IP` |
| Lobby with fewer than two players | closed after 15 minutes without a change of seats, whatever traffic it gets | |
| HTTP requests per address (not `/healthz`) | 40 at once, then 20 a second; over that: `429` with `Retry-After: 1` | |
| WebSocket upgrades per address | 10 at once, then 2 a second; over that: `429` before any handshake | |
| WebSocket from another site | refused (`403`) unless its `Origin` is the server's own host or listed | `ALLOWED_ORIGINS` (comma-separated, e.g. `https://example.com`) |
| Message burst per connection | 60, refilling 30 a second | |
| Sockets in no room that only ping | closed after 5 minutes | |
| Abandoned rooms per address | 4 (the fifth create drops that address's oldest) | |
| Failed joins per address (a code that does not exist) | 8 a minute, then joins are answered `rate`; a successful join clears the count | |

When the server is full, `create` and `practice` are answered `server_full`; a room is never destroyed to
make space for someone else's, and one address cannot take more than its few rooms (a lobby nobody joins is
closed after 15 minutes), so a player who reloads keeps their game (their seat is held for the grace
period: 60 seconds, as an allowance that refills slowly in a running game against another human, and in full
for every drop in the lobby or against the AI).

The public files are read into memory when the server starts and sent with a strong `ETag` (a repeat request is
answered `304`); a file changed on disk is not served until the process restarts. Measured on a development
desktop, the CPU per request fell from about 0.3 to 0.4 ms (read from disk each time) to about 0.03 ms for
`client.js` and 0.02 ms for an unknown path.

The WebSocket `Origin` check compares the page's host with the `Host` header the server receives. On Render and
behind Cloudflare that is normally the public hostname; if your platform
rewrites `Host`, put the public origin in
`ALLOWED_ORIGINS`.

Why 60 rooms: measured on a development desktop, a practice battle costs 0.02 to 0.05 ms of CPU per 50 ms tick
(simulation, bot, snapshot and send; 25 to 200 concurrent battles; 200 battles used about 8% of one core).
The free Render instance has 0.1 CPU: 10 ms of CPU in each 100 ms period, after which the whole process,
event loop included, is paused until the next period. With two ticks per period, 60 battles need 2.4 to 6 ms
of the 10 (about 0.03 ms each: 3.6 ms), which leaves room for garbage collection, HTTP, handshakes and a
slower core. The former 200 would have needed 8 to 20 ms: 80% of the allowance at the very best and usually
more than all of it, so ticks run late and battles slow down. (Event-loop delay stayed within timer
resolution at every size on the test machine, so it does not show the limit; the arithmetic against the
quota does. Raise `MAX_ROOMS` on a paid plan with more CPU.)

## License

MIT. See [LICENSE](LICENSE).
