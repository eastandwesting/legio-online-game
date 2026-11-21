# Legio Online

An original ancient-world strategy game for two players in the browser: real-time battles and a
turn-based campaign map. Nothing here is taken from, or affiliated with, any commercial title. The
factions, units and rules are invented for this project.

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
- A battle ends when one army routs, or at the 5-minute limit. At the limit the defender holds (in a
  campaign); in a quick battle the side with more of its army left wins, and near-equal is a draw.

### Campaign rules

- 13 provinces. Each owned province pays 40 gold per turn; recruit units in provinces you own.
  Maximum 16 units per player.
- Both players give orders at once, then end the turn. Armies that meet in a province fight a live
  battle; armies that try to swap provinces turn back.
- Winners keep their survivors, regrouped into full-strength units. Units standing in your own
  provinces regain 25% of their strength each turn.
- The province owner is the defender. Take the enemy capital to win; both capitals falling in one turn
  is a draw.
- If one human ends their turn and the other stalls, a 90-second hurry-up timer ends it for them.

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
  pick the repository.
- **Anything with Docker** (Fly.io, Railway, a VPS): use the `Dockerfile`; it listens on `PORT`.
- Behind a proxy the client IP is read from `X-Forwarded-For` when the `RENDER` environment variable is
  set; otherwise pass `trustProxy: true` to `createGameServer`.

Things to expect on a free tier: the service sleeps when idle (first visit can take about a minute) and
any restart drops games in progress. `GET /healthz` returns `ok`; `GET /healthz?stats` adds room and
connection counts.

Limits: 200 rooms, 500 connections, 20 per IP, 60-message burst per connection. All are options of
`createGameServer`.
