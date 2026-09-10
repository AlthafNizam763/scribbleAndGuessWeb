# Scribble & Guess — backend

Authoritative REST + Socket.IO server for the Scribble & Guess Flutter app.

**This project has no game UI and no admin panel.** It serves an API, a
websocket, and one static status page at `/`. The game itself is the Flutter
app in `../scribbleAndGuessAppication`.

```
Flutter app  ──HTTPS──▶  Next.js route handlers ──┐
     │                                            ├──▶  services  ──▶  MongoDB
     └────────WebSocket──▶  Socket.IO handlers  ──┘
```

In development both transports run on **one origin and one port**: `server.ts`
boots Next.js as a request handler inside a Node HTTP server and attaches
Socket.IO to it. That is also why they share one in-memory game registry — see
[Architecture](#architecture).

In production they are **two deployments from this one repository**, because
Socket.IO cannot run on a serverless host — it has no persistent process to
hold a websocket open, and nothing there executes `server.ts`. The REST API
stays serverless; `socket-server.ts` runs the realtime half on a host that
keeps a process alive. See [Production](#production) for why that split is
safe and how to deploy it.

---

## Contents

- [Quick start](#quick-start)
- [Environment](#environment)
- [Architecture](#architecture)
- [REST API](#rest-api)
- [Socket.IO protocol](#socketio-protocol)
- [Game rules](#game-rules)
- [Security model](#security-model)
- [Testing](#testing)
- [Production](#production)

---

## Quick start

You need Node 20+ and a MongoDB instance.

```bash
cd scribbleAndGuessWeb
npm install

cp .env.example .env.local
# Generate a signing key and paste it into JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

npm run seed        # imports the Flutter app's word bank (~2,300 words, 8 languages)
npm run dev         # http://localhost:3000
```

Verify:

```bash
curl http://localhost:3000/api/health
# {"success":true,"status":"healthy","database":"connected",
#  "socket":{"mode":"attached","status":"up","rooms":0,"players":0},...}
```

Then point the app at it:

```bash
cd ../scribbleAndGuessAppication
flutter pub get
flutter run --dart-define=API_BASE_URL=http://localhost:3000
```

`API_BASE_URL` defaults to `http://10.0.2.2:3000` on Android (the emulator's
route to your host) and `http://localhost:3000` elsewhere, so the default
usually just works. A **physical** phone needs your machine's LAN address:

```bash
flutter run --dart-define=API_BASE_URL=http://192.168.1.42:3000
```

with `HOST=0.0.0.0` in the backend's `.env.local`.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server with reload — REST **and** Socket.IO on one port |
| `npm run dev:socket` | Realtime server only, with reload |
| `npm run build` | Compiles Next and both server entry points to `dist/` |
| `npm run build:socket` | Compiles the realtime server only (skips `next build`) |
| `npm start` | Runs the compiled combined server |
| `npm run start:socket` | Runs the compiled **realtime** server (`socket-server.ts`) |
| `npm run seed` | Seeds `words`. Idempotent — safe to re-run |
| `npm run seed -- --language=en --reset` | Reseeds one language from scratch |
| `npm run sync-indexes` | Rebuilds indexes after a schema change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (no database needed) |
| `npm run test:e2e` | Full three-client game against a running server |

---

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MONGODB_URI` | yes | `mongodb://localhost:27017/scribbleAndGuess` | Database name is part of the URI |
| `JWT_SECRET` | yes | — | Refused in production if short or still the placeholder |
| `JWT_EXPIRES_IN` | no | `30d` | |
| `PORT` | no | `3000` | |
| `HOST` | no | `0.0.0.0` | |
| `NEXT_PUBLIC_API_URL` | no | `http://localhost:3000` | Advertised to clients |
| `SOCKET_URL` | no | `http://localhost:3000` | The realtime origin. Advertised to clients, and probed by `/api/health` when the two halves are deployed separately |
| `CORS_ORIGIN` | no | `*` | Comma-separated, or `*`. Only gates browsers — native clients send no `Origin` |
| `LOG_LEVEL` | no | `info` | `error` \| `warn` \| `info` \| `debug` |

Startup fails loudly on a missing or malformed value rather than surfacing it
as a confusing error on the first request.

---

## Architecture

```
src/
├── app/api/          Next route handlers — thin, one per endpoint
├── controllers/      HTTP ⇄ service translation. No rules here
├── services/         All game rules and permissions live here
├── repositories/     Queries only. No rules, no broadcasting
├── models/           Mongoose schemas
├── socket/           Socket.IO handlers, also thin
├── middleware/       Auth, errors, rate limiting, validation
├── validators/       Zod schemas
├── config/           env, database, socket instance
├── constants/        Wire enums, tunable game numbers, event names
├── types/            DTOs matching the Flutter models exactly
└── utils/            Errors, logger, room codes, guess matching
```

**Rules live in services, not in handlers.** The REST layer and the socket
layer both call the same service methods, so `POST /api/games/start` and
`c:game:start` enforce identical checks. A handler that implemented its own
permission check would be a way around the other one.

### Live state is in memory; Mongo is written through

The realtime loop touches room state on every stroke, guess and timer tick.
Round-tripping to Mongo for each would put database latency in the one place
players notice most, so the authoritative game state is a `Map` in this
process (`RuntimeRoom`), and Mongo is written on changes worth surviving a
restart: joins, leaves, scores, round ends. Drawing **never** touches Mongo
except as one snapshot per turn.

The registry and the Socket.IO instance both live on `globalThis`. That is not
incidental: Next.js compiles route handlers into a separate module registry
from `server.ts`, so a module-level variable would give the two layers
different copies and every REST-triggered broadcast would silently go nowhere.

A restart drops in-flight rounds; rooms are rebuilt from Mongo when a player
reconnects, and land back in the lobby.

---

## REST API

All responses:

```jsonc
{ "success": true, "data": { } }
{ "success": false, "error": { "code": "ROOM_NOT_FOUND", "message": "Room not found." } }
```

Authenticate with `Authorization: Bearer <token>`.

### `POST /api/auth/guest`

Creates a guest account. **Unauthenticated** — this is the call that mints the
token everything else presents.

```jsonc
// request
{ "username": "Althaf", "avatarId": 1, "avatarColorIndex": 2 }

// 201
{ "success": true, "data": {
  "token": "eyJhbGciOi...",
  "user": { "id": "6aa2...", "username": "Althaf", "avatarId": 1, "avatarColorIndex": 2 }
}}
```

`avatarId` is an integer index into the 18 procedural avatars, not a string
like `"avatar_01"` — the app draws avatars with a `CustomPainter` keyed by
`(avatarId, avatarColorIndex)`, so there is no asset name to carry.

Errors: `VALIDATION_ERROR` (422), `RATE_LIMITED` (429).

### `GET /api/auth/session`

Verifies a stored token and returns its user. Used at startup so a returning
player skips the name prompt, and so a revoked token is found early.

Errors: `AUTH_ERROR` (401).

### `GET /api/users/me` · `PATCH /api/users/me`

Profile and lifetime stats. `PATCH` accepts **only** `username`, `avatarId`
and `avatarColorIndex`; `score`, `gamesWon`, `gamesPlayed` and permissions are
not parameters of the service that performs the write, so there is no path
from a request body to a stat.

```jsonc
// PATCH request
{ "username": "Althaf", "avatarId": 4 }
```

Errors: `AUTH_ERROR` (401), `VALIDATION_ERROR` (422).

### `POST /api/rooms`

Creates a room and makes the caller its host. Both body shapes work:

```jsonc
{ "maxPlayers": 8, "rounds": 3, "wordsToChoose": 3, "hintsEnabled": true,
  "hintCount": 2, "wordMode": "normal", "language": "en" }
// or
{ "settings": { "maxPlayers": 8, "rounds": 3, "drawTimeSeconds": 80 } }
```

Out-of-range numbers are **clamped, not rejected** — an out-of-date client
gets a playable room rather than an error it cannot act on. Unknown categories
are dropped; unknown enum values fall back to the default.

Returns `{ room }`. Errors: `AUTH_ERROR`, `VALIDATION_ERROR`, `RATE_LIMITED`.

### `POST /api/rooms/join`

```jsonc
{ "roomCode": "A7K9P" }
```

Validates that the room exists, is not full, the caller is not banned, and the
game is not in its final scoreboard. A player who is **already a member**
always gets back in with their score and seat intact — that is what makes a
dropped connection survivable.

Errors: `ROOM_NOT_FOUND` (404), `ROOM_FULL` (409), `PLAYER_BANNED` (403),
`INVALID_ROOM_CODE` (422).

### `GET /api/rooms/:roomId`

Accepts a room id **or** a room code. Returns `{ room, lobby, game }`, where
`game` is serialised for the calling player — the word is omitted unless they
are the drawer or the round has ended. Private rooms 404 for non-members.

### `POST /api/rooms/:roomId/leave` · `PATCH /api/rooms/:roomId/settings` · `POST /api/rooms/:roomId/ready`

Leave; replace settings (host only, between games only); set the ready flag.
`maxPlayers` cannot be lowered below the current occupancy.

Errors: `NOT_ROOM_MEMBER` (403), `NOT_ROOM_OWNER` (403),
`GAME_ALREADY_STARTED` (409).

### `POST /api/games/start`

```jsonc
{ "roomId": "6aa2..." }   // or { "roomCode": "A7K9P" }
```

Host only, minimum two connected players. Shuffles turn order, creates the
game, opens turn 1.

Errors: `NOT_ROOM_OWNER` (403), `GAME_ALREADY_STARTED` (409),
`INVALID_ACTION` (409, too few players).

### `GET /api/games/:gameId` · `GET /api/games/:gameId/rounds`

Match history. A **live** game returns progress only — round summaries carry
every word played, so they are withheld until the game has ended.

### `GET /api/words/categories` · `GET /api/words/stats`

Category names and counts, so the create-room screen can show what is worth
picking. **There is deliberately no endpoint that returns words.** One that did
would let any player download every possible answer.

### `GET /api/leaderboard?limit=50&page=1`

Public (auth optional). Ranked by lifetime score, ties broken by wins then id
so the order is stable between requests. A signed-in caller also gets their own
rank as `self`.

### `GET /api/health`

Unauthenticated, so a load balancer probe works. Returns **503** when the
database is unreachable, so an orchestrator actually drains the instance. A
realtime outage does *not* return 503 — guest sign-in still works without it —
but it does degrade `status`.

Running as one process (`npm run dev`, `npm start`), the socket is checked
in-process:

```jsonc
{ "success": true, "status": "healthy", "database": "connected",
  "socket": { "mode": "attached", "status": "up", "rooms": 3, "players": 11 },
  "uptimeSeconds": 8412 }
```

Deployed split, this route **asks** the realtime server rather than guessing,
and reports whatever it actually said:

```jsonc
{ "success": true, "status": "healthy", "database": "connected",
  "socket": { "mode": "external", "status": "up",
              "url": "https://scribble-and-guess-realtime.onrender.com",
              "rooms": 3, "players": 11, "checkedAt": "2026-01-01T00:00:00.000Z" } }
```

When the realtime server is unreachable it says so, with the reason — it never
reports `up` on the strength of `SOCKET_URL` merely being set:

```jsonc
{ "success": true, "status": "degraded", "database": "connected",
  "socket": { "mode": "external", "status": "down",
              "url": "https://...", "reason": "fetch failed" } }
```

The realtime server answers `GET /healthz` with the same information about
itself, and that is what a platform health check should point at.

### Error codes

`AUTH_ERROR` `VALIDATION_ERROR` `ROOM_NOT_FOUND` `ROOM_FULL`
`NOT_ROOM_MEMBER` `NOT_ROOM_OWNER` `GAME_NOT_STARTED` `GAME_ALREADY_STARTED`
`NOT_DRAWER` `INVALID_WORD` `ROUND_ENDED` `ALREADY_GUESSED` `PLAYER_BANNED`
`PLAYER_MUTED` `RATE_LIMITED` `INTERNAL_ERROR` `NOT_FOUND`
`INVALID_ROOM_CODE` `NAME_TAKEN` `INVALID_ACTION`

---

## Socket.IO protocol

Same origin, default path (`/socket.io`).

### Authentication

The JWT goes in the **handshake**, not in an event:

```dart
io.io(url, io.OptionBuilder()
    .setTransports(['websocket'])
    .setAuth({'token': jwt})
    .build());
```

A connection middleware verifies it before any handler runs; a socket without
a valid token is refused at the handshake and never reaches the game. The
identity comes from the token alone — the profile sent on `c:hello` is display
data, and its `id` is ignored.

### A note on event names

The canonical names are the `c:` / `s:` protocol from the Flutter app's
`docs/CONTRACT.md` §8, mirrored in `lib/core/constants/socket_events.dart`.
The app was already written against them, so they are what this server speaks.

The names in the original brief's §16 (`room:join`, `game:start`,
`drawing:stroke`, `guess:submit`, …) are registered as **aliases** onto the
same handlers with the same payloads, so either vocabulary works. New clients
should prefer the canonical names.

### Client → server

Every event below acks with `{ok: true, ...}` or
`{ok: false, error: {code, message}}` unless marked otherwise. Ack error codes
use the app's `AppErrorCode` vocabulary (`roomFull`, `notHost`, `notDrawer`,
`validation`, …), not the REST codes.

| Event | Payload | Notes |
|---|---|---|
| `c:hello` | `{profile}` | Acks `{serverTimeMs, playerId}`. Restores a seat if one is held |
| `c:time:ping` | `{t0}` | Acks `{t0, t1}` — **no** `ok` envelope |
| `c:room:create` | `{settings}` | Acks `{room}` |
| `c:room:join` | `{code}` | Acks `{room}` |
| `c:room:leave` | `{}` | |
| `c:room:ready` | `{ready}` | |
| `c:room:settings` | `{settings}` | Host only |
| `c:room:kick` | `{playerId}` | Host only |
| `c:room:ban` | `{playerId}` | Host only |
| `c:room:mute` | `{playerId, muted}` | Host only |
| `c:room:transferHost` | `{playerId}` | Host only |
| `c:room:voteKick` | `{playerId}` | Acks `{votes, threshold, passed}` |
| `c:room:report` | `{playerId, reason}` | |
| `c:game:start` | `{}` | Host only |
| `c:game:selectWord` | `{index}` | Drawer only |
| `c:game:playAgain` | `{}` | Host only |
| `c:draw:begin` | `{stroke}` | **No ack.** Drawer only |
| `c:draw:append` | `{strokeId, points}` | **No ack.** Drawer only |
| `c:draw:end` | `{strokeId}` | **No ack.** Drawer only |
| `c:draw:undo` / `redo` / `clear` | `{}` | **No ack.** Drawer only |
| `c:chat:send` | `{text}` | Acks `{verdict}`: `correct` \| `close` \| `wrong` |

### Server → client

| Event | Payload |
|---|---|
| `s:room:state` | `{room}` |
| `s:room:closed` | `{reason}` |
| `s:you:kicked` | `{reason}` |
| `s:game:state` | `{game}` — **per recipient**; `word` omitted unless drawer or round ended |
| `s:game:wordChoices` | `{choices}` — drawer only |
| `s:game:roundStart` | `{game}` |
| `s:game:hint` | `{hintIndices, maskedWord}` |
| `s:game:roundEnd` | `{result, game}` — the answer is revealed here |
| `s:game:end` | `{result}` |
| `s:draw:begin` / `append` / `end` / `undo` / `redo` / `clear` | stroke payloads, sender excluded |
| `s:draw:snapshot` | `{strokes}` — sent to late joiners and on reconnect |
| `s:chat:message` | `{message}` |
| `s:time:sync` | `{serverTimeMs}` |
| `s:error` | `{error}` |

### Drawing payloads

Keys are one letter because this is the highest-frequency message in the game
— a batch every 60ms while a finger is down:

```jsonc
{ "id": "stroke123", "a": "<authorId>", "p": [[0.21, 0.32], [0.22, 0.34]],
  "c": 4278190080, "w": 5, "t": "pen", "ts": 1736500000000 }
```

Coordinates are normalised to `0.0–1.0` against a 4:3 canvas, so a drawing made
on a tablet lands in the same place on a phone. The server clamps them rather
than rejecting — a value a hair outside the box is a rounding artefact, and
dropping the batch would make lines stutter at the edge. The author is always
overwritten from the authenticated socket.

---

## Game rules

### Phases

```
lobby → starting → word_selection → drawing → round_result
                        ▲                          │
                        └────── next turn ─────────┘
                                                   │
                                          final_result → lobby
```

One **round** is one pass around the table; each player draws once per round.
`rounds: 3` with 4 players is 12 turns.

### The timer is the server's

`turnStartMs` and `turnEndMs` are absolute epoch milliseconds on the server
clock. Clients measure their offset with `c:time:ping` (five round trips,
keeping the fastest) and render a countdown from those. A device with a wrong
clock shows the wrong seconds but **cannot change when the round ends** — only
this process ends a round.

### Word privacy

The single most important rule. The word is sent to exactly two audiences: the
current drawer, and everybody once the turn has ended. Because one broadcast
would have to serve recipients with different entitlements, game state goes out
through a per-recipient loop, not `io.to(room).emit`. A correct guess is never
echoed as text either — it is replaced by "Althaf guessed correctly!".

The e2e suite asserts the strong form: the answer must not appear **anywhere**
in a guesser's entire received transcript.

### Scoring

```
guesser = (min + (max − min) × timeRatio + orderBonus) × difficultyMultiplier
drawer  = pointsPerGuess × guessers   (+ bonus if everyone got it, capped)
```

Defaults: `max 100`, `min 30`, order bonus `25/15/8` for 1st/2nd/3rd, drawer
`20` per guesser `+30` clean sweep, capped at `120`; multipliers `1.0 / 1.15 /
1.35`. All in `constants/game.constants.ts`.

The brief's worked example uses `base + secondsLeft × 2`. This is the same idea
normalised against the round length, because the host can set the timer from 30
to 180 seconds and a flat per-second bonus would make a long round worth triple
a short one for identical play. A guess at the buzzer still scores `min` — a
game where a late correct answer is worthless teaches players to stop trying.

### Double-scoring is impossible

`player.hasGuessed` is read and written in one synchronous block before any
`await`. Node is single-threaded, so two guesses in the same tick cannot both
see `false`. The database write behind it carries its own guard
(`recordCorrectGuess` filters on the user not already being in the array), so
even a second process could not double-award.

### Hints

Revealed across the middle of the turn (45%–85%), never in the opening seconds
when guessing is worth the most. Each hint goes to the position **furthest**
from everything already revealed, because two adjacent letters give away far
less than two spread out. Never more than half the word. Spaces and hyphens are
always visible and never count as a hint.

### Disconnects

A dropped player keeps their seat, score and correct-guess status for 45
seconds. A dropped **drawer** gets a shorter 12-second grace before the turn is
handed on — the game is not torn down (brief §39). A player with two devices
goes offline only when the last socket drops.

---

## Security model

The client is never trusted for: score, the answer, the timer, who draws, who
won, who hosts, permissions, or round status. Concretely:

- Identity comes from the JWT, never from a payload field.
- Stroke authorship is overwritten from the socket, so a guesser cannot
  attribute strokes to the drawer.
- `c:game:selectWord` takes an **index into the choices this server offered**,
  not a word — a client cannot draw something that was never on the list.
- Muted players are refused before their guess is evaluated, so mute cannot be
  used to probe the word.
- The drawer's own messages are never evaluated as guesses.
- Zod validates every payload; unknown keys are stripped, not trusted.
- Rate limits are token buckets (burst + sustained) so quick guessing works but
  flooding does not. Drawing is bounded by size and count instead, since a
  drawer legitimately emits ~17 batches a second.
- Logs redact `word`, `answer`, tokens and secrets — a live answer in a log the
  whole team can read is a cheating vector.
- Reports are write-only. No endpoint reads them back.

---

## Testing

```bash
npm test          # 85 unit tests, no database required
npm run test:e2e  # 46 checks, three real clients, needs a running server

# 26 checks against a *split* deployment: REST on one origin, realtime on
# another. Defaults to the Vercel API plus a local realtime server.
node tests/realtime.twoclient.mjs
REST_URL=https://scribble-and-guess-web.vercel.app   SOCK_URL=https://your-realtime-host node tests/realtime.twoclient.mjs
```

Unit tests cover scoring properties (speed beats order, difficulty scales,
caps hold, ties rank correctly), guess normalisation (case, accents, aliases,
one-letter near misses, non-Latin scripts), the hint engine (never more than
half, idempotent, spaces free), room codes, settings clamping, the timer and
the drawing board.

`npm run test:e2e` walks the brief's Definition of Done with three
authenticated clients over a real websocket: guest login → create → join by
code → ready → start → server picks the drawer → drawer gets words → **other
players do not** → drawing relays → non-drawer refused → guessing → scoring →
duplicate guess refused → timer ends → answer revealed → next drawer → final
result → play again.

`tests/realtime.twoclient.mjs` is the same idea aimed at the split deployment:
it mints its JWTs from the REST origin and presents them to a *different*
realtime origin, which is what proves the two halves share a signing key. It
covers connect, a refused bad token, hello and clock sync, create and join,
presence in both directions, ready, start, drawer secrecy, word selection,
stroke relay, guess validation, the anti-leak rule on chat, automatic
reconnect with seat restore, and leave.

---

## Production

### Socket.IO cannot run on a serverless host

This is worth stating plainly, because getting it wrong produces a backend
that looks healthy and cannot play a game.

A serverless platform — Vercel, Netlify Functions, Lambda behind API Gateway —
starts a function to answer a request and tears it down afterwards. It never
holds a websocket open, and nothing on it executes `server.ts`, which is the
only thing that calls `attachSocketServer`. Deployed that way, `/api/health`
reports `socket: detached` and `/socket.io/` returns a 404 page, because there
is no Socket.IO server in the process at all. No amount of configuration fixes
that; the runtime cannot do it.

So production runs **two deployments from this one repository**:

```
Flutter (Android/iOS)
   │
   ├── HTTPS ──▶  REST API          `src/app/api`, serverless (Vercel)
   │                 │              auth, session, profile, leaderboard
   │                 ▼
   │              MongoDB
   │                 ▲
   │                 │
   └── WSS ────▶  Realtime server   `socket-server.ts`, a persistent Node process
                     │              rooms, game, drawing, guessing, chat, timers
                     ▼
                  MongoDB
```

Both read the same `MONGODB_URI` and sign with the same `JWT_SECRET`, so the
token `/api/auth/guest` mints on the REST side authenticates the socket
handshake on the realtime side.

#### Why splitting them is safe

Live rooms are a process-local `Map` (see *Live state is in memory*), so REST
and realtime must not both mutate it from separate processes. They do not: the
Flutter client uses REST only for guest sign-in, the session and the profile —
all stateless and Mongo-backed — and does every stateful thing over the socket.
The registry therefore lives entirely in the realtime process, which is the
single-owner arrangement it was designed for.

The REST room endpoints (`POST /api/rooms`, `/api/rooms/join`, …) still work,
but they touch the REST deployment's own registry. They are useful against a
single-process backend and for testing; the app does not use them.

### Deploying the REST half (Vercel)

Nothing special — it is a stock Next.js app. Set these in the project's
environment: `MONGODB_URI`, `MONGODB_DB`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
`CORS_ORIGIN`, `LOG_LEVEL`, and `SOCKET_URL` pointing at the realtime
deployment so `/api/health` can report the realtime state truthfully.

### Deploying the realtime half

Any host that keeps a process alive. `render.yaml` is ready to use as a
Blueprint; the `Dockerfile` covers Railway, Fly.io, or a plain VM.

```bash
npm ci
npm run build:socket          # tsc + tsc-alias; no `next build` needed
npm run start:socket          # node dist/socket-server.js
```

Set `HOST=0.0.0.0` (or a container health check cannot reach it), let the
platform inject `PORT`, and point the health check at `/healthz`.

### Running both in one process

Still supported, and what `npm run dev` does. Any host with a persistent
process can serve the whole backend from one address:

```bash
npm run build
NODE_ENV=production npm start
```

Behind a reverse proxy, forward the upgrade headers or websockets silently
fall back to polling:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 120s;
}
```

### Scaling out

Live rooms are held per-process, so **run one instance** unless you add both of
these:

1. The Redis adapter — `io.adapter(createAdapter(pub, sub))` in
   `attachSocketServer`. Every broadcast already targets a named Socket.IO room
   rather than a socket list, so nothing else changes.
2. Room affinity, so every socket for a room lands on the process that owns its
   `RuntimeRoom`.

Sticky sessions alone are not enough: they keep a *client* on one process, not
a *room*.

### Checklist

- [ ] `JWT_SECRET` is long and random, not in git, and **byte-identical on both
      deployments** — a mismatch rejects every socket handshake with `AUTH_ERROR`
- [ ] Both deployments point at the same `MONGODB_URI` / `MONGODB_DB`
- [ ] `SOCKET_URL` on the REST deployment names the realtime host
- [ ] The Flutter build is given the realtime host too:
      `--dart-define=SOCKET_URL=https://…`, or `AppConfig.deployedRealtimeUrl`
- [ ] `CORS_ORIGIN` is a real list, not `*`, if browsers will connect
- [ ] `npm run seed` has been run against the production database
- [ ] `npm run sync-indexes` after any schema change
- [ ] `/api/health` is wired to the load balancer (it returns 503 when the
      database is down), and the realtime host's check points at `/healthz`
- [ ] `/api/health` reports `socket.status: "up"` — not `detached`, not
      `down` — before calling the deployment finished
- [ ] `LOG_LEVEL=info`; logs shipped somewhere
