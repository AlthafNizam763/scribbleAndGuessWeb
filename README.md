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
- [Voice chat](#voice-chat)
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
| `WEBRTC_STUN_URL` | no | `stun:stun.l.google.com:19302` | Voice chat. Comma-separated list accepted. Free, and enough on its own for most networks |
| `WEBRTC_TURN_URL` | no | — | Optional relay fallback (Coturn). **Not free** — all audio passes through it |
| `WEBRTC_TURN_USERNAME` | no | — | Never commit. Handed to clients over `s:voice:state` |
| `WEBRTC_TURN_CREDENTIAL` | no | — | Never commit |

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

### Collections

| Collection | Holds | Notable indexes |
|---|---|---|
| `users` | Accounts, including guests. Lifetime stats and optional locality | `{email}` unique-partial · `{totalScore:-1, gamesWon:-1, _id:1}` · `{localityKey:1, totalScore:-1, gamesWon:-1, _id:1}` · `{username}` |
| `rooms` | Durable room records, players embedded | `{roomCode}` unique-partial · `{closedAt, settings.isPrivate, status, createdAt}` |
| `games` · `rounds` | Finished matches and turns | |
| `words` | Seeded reference data | |
| `chatmessages` · `reports` | Transcripts, write-only reports | |
| `friend_requests` | One row per request, kept after it resolves | `{pairKey}` unique-partial on `pending` · `{receiverId, status, createdAt}` · `{senderId, status, createdAt}` |
| `friendships` | **One row per pair**, ids stored sorted | `{userAId, userBId}` unique · one per field for the `$or` |
| `blocks` | Directional: belongs to the blocker | `{blockerId, blockedUserId}` unique · `{blockedUserId}` |
| `room_invitations` | One row per invitation, kept after it resolves | `{roomId, inviteeId}` unique-partial on `pending` · `{inviteeId, status, createdAt:-1}` · `{status, expiresAt}` |
| `notifications` | One nudge per person, expiring after 30 days | `{userId, createdAt:-1, _id:-1}` · `{userId, createdAt:-1}` partial on unread · `{expiresAt}` TTL |
| `achievements` | One unlock per player per key | `{userId, key}` **unique** — this is the whole duplicate rule · `{userId, createdAt:-1}` |
| `xp_events` | XP history; a log, never the authority | `{userId, createdAt:-1, _id:-1}` · `{expiresAt}` TTL (90 days) |

Two shapes are worth the note:

**A friendship is one row, not two.** The obvious two-row shape — `(a→b)` and
`(b→a)` — is also the one that cannot be made correct: it can be half-written,
duplicates are only preventable per direction, and every removal has to find
both rows or leave a friendship that exists for one person and not the other.
Storing the pair once with sorted ids makes the unique index the whole
duplicate story and makes removal a single `deleteOne`. The cost is that a
friend list is an `$or` over two fields, which the two indexes serve.

**A block is deliberately *not* a sorted pair.** It belongs to whoever made it:
they can lift it, the other party cannot see it, and both directions can exist
independently.

The leaderboard indexes carry `_id` as their last key on purpose. Without it
Mongo walks the index for the first two fields and then sorts the ties in
memory — slower, and an outright error past the 32MB sort limit on a large
board.

Run `npm run sync-indexes` after pulling these models. Mongoose creates missing
indexes but never *changes* an existing one, so a leaderboard index built from
the older two-key definition would stay two-key.

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

Kept at its original path and in its original response shape so anything
already reading it keeps working. It is the world board underneath; new
clients should call `/world` below and get the richer envelope.

### `GET /api/leaderboard/world` · `/friends` · `/locality`

The three scoped boards. `?page=` and `?limit=` on all of them; `limit` is
clamped to 100 and `page` is refused past 400, because a skip is `O(skip)` in
Mongo and an uncapped page number is a way to make the server do arbitrary
work for one request.

| Scope | Auth | Population |
|---|---|---|
| `world` | optional | Everyone with `gamesPlayed > 0` |
| `friends` | **required** | The caller plus their accepted friends, including anyone on zero games |
| `locality` | **required** | Everyone sharing the caller's `localityKey` |

```jsonc
{
  "success": true,
  "data": {
    "scope": "world",
    "items": [ /* rank, card, stats, winRate, isSelf, rankChange */ ],
    "currentUserRank": 4212,      // absolute, even when far off this page
    "currentUserEntry": { /* … */ },
    "total": 51834,
    "page": 1,
    "limit": 25,
    "hasMore": true
  }
}
```

Ranking is `totalScore` desc, `gamesWon` desc, `_id` asc, and it is **derived
on every read** — a stored rank would be stale for every player but one the
moment anybody finished a game. The `_id` key is what makes the order total, so
equal rows do not reshuffle between requests.

`rankChange` is always `null` today: nothing records what anybody's rank *was*,
and an arrow drawn from no history would be invented. The field is on the wire
so adding a snapshot job later needs no new client build.

The locality board groups by a normalised `country|region|city` key. A caller
with no city set gets an empty page and `locality: null`, which the app renders
as a prompt to finish their profile rather than as an error.

### `GET /api/leaderboard/me/rank?scope=world|friends|locality`

The caller's standing without a page of rows, so a client can show "you are
4,212nd" without paging to find them. `rank` is `null` for a player who has
never finished a game.

### `POST /api/rooms/quick-play`

Finds a public room with a free seat and seats the caller, opening one when
nothing suitable is waiting. **Takes no parameters** — the point of the button
is that there is nothing to decide.

Never matches a private room, a full one, a game already in progress, one the
caller is banned from, or one holding somebody a block stands between. Ranks
candidates by how full they are (closest to starting first), ties broken by
age, so a burst of simultaneous taps converges on one room.

There is no second engine here: matchmaking picks a room and
`roomService.joinRoom` seats the player, exactly as the room-code path does.

```jsonc
{
  "success": true,
  "data": {
    "room": { /* … */ },
    "roomCode": "A7K9P",
    "created": false,       // a room had to be opened
    "alreadySeated": false, // the caller was already in this room
    "joined": true          // see below
  }
}
```

`joined` says whether the caller was actually seated. In the single-process
deployment it is always `true`. In the split deployment this process has no
live room registry to seat anybody in, so it names a room out of Mongo and
answers `joined: false`; the client then joins it over the socket, which is
where the authoritative checks run anyway. **The Flutter client uses
`c:room:quickPlay` instead** and is always seated in one round trip.

### `GET /api/users/search?q=&limit=`

Players whose name starts with `q`. Rate limited per caller, hard-capped at 25
results, and excludes the caller plus everyone a block stands between — a
blocked user is simply absent from the world rather than visibly hidden. Each
result carries its `relation`, so a list draws the right button per row without
a request per row.

### `GET /api/users/:userId/profile`

Another player's public card, stats, world rank, and the caller's `relation` to
them — the single value the app's profile button is drawn from. Computed
server-side so a stale client cannot offer an action the server would refuse.

A caller who has been blocked sees a profile identical to a stranger's
(`relation: "none"`), and their Add Friend tap is refused with a message that
does not say why.

### `PATCH /api/users/me/locality`

`{city, region, country}` — a two-letter ISO country code. Separate from
`PATCH /api/users/me` because the set of fields an endpoint can write is the
security boundary: a body aimed at renaming somebody must not also relocate
them. There is no field here, on the endpoint, or on the user document for a
street, a postcode or a coordinate.

### Friends

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/friends/requests` | Body names the receiver only; the sender is the token |
| `GET` | `/api/friends/requests/incoming` | Who is waiting on you |
| `GET` | `/api/friends/requests/outgoing` | Who you are waiting on |
| `POST` | `/api/friends/requests/:id/accept` | Receiver only |
| `POST` | `/api/friends/requests/:id/reject` | Receiver only |
| `POST` | `/api/friends/requests/:id/cancel` | Sender only |
| `GET` | `/api/friends` | Accepted friends |
| `DELETE` | `/api/friends/:userId` | Ends the friendship for both at once |

A request id is **not a capability**: the caller's right to act is checked
against the loaded row, so guessing one gets `NOT_ROOM_MEMBER` rather than
somebody else's friendship.

Refused: adding yourself, a duplicate pending request **in either direction**,
adding somebody a block stands between, accepting into a block placed after the
request was sent, and acting on a request that has already been handled.

### Blocks

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/blocks/:userId` | Ends the friendship, cancels pending requests both ways |
| `DELETE` | `/api/blocks/:userId` | Lifts the block; restores nothing |
| `GET` | `/api/blocks` | The caller's own list only |

There is deliberately no "who has blocked me" endpoint, and no event tells a
blocked user they were blocked. Unblocking does **not** restore the friendship
it destroyed — quietly resurrecting something somebody deliberately ended would
be the opposite of what they asked for.

### Notifications

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/notifications?page=&limit=&unreadOnly=` | The caller's own inbox, newest first |
| `PATCH` | `/api/notifications/:id/read` | Owner only |
| `PATCH` | `/api/notifications/read-all` | Clears the whole backlog in one write |
| `DELETE` | `/api/notifications/:id` | Owner only |

**There is no create endpoint.** Every notification is written by a service,
from an event that already happened — `notificationService.notify` is the only
writer, and nothing else in the codebase touches the collection. A create route
would be the whole of what a spam feature needs.

Every response carries `unreadCount`, capped at 99, so the badge never needs a
second request and a client never does the arithmetic itself. A client that
decremented its own counter would drift the first time it missed a push —
which happens on every backgrounded app — and nothing would correct it.

A notification id is **not a capability**: ownership is the update's filter, so
a stranger's id returns the same `NOT_FOUND` an id that never existed does.
Marking an already-read row read is a no-op rather than an error.

Rows carry an `expiresAt` 30 days out and a TTL index deletes them. Unlike
`RoomInvitation.expiresAt` — which is a *state* the accept path checks, and
deliberately not a TTL — expiry here really is deletion: everything a
notification points at is stored authoritatively elsewhere and outlives the
nudge.

Producers today: friend request sent, friend request accepted, room invitation
sent. Each writes the row *and* emits its existing domain event — the domain
event tells a screen its list is stale, the notification event tells the badge
its count changed, and a client is rarely showing both.

### Drawing replays

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/games/:gameId/replays` | Finished turns, **without** strokes |
| `GET` | `/api/games/:gameId/replays/:turnNumber` | One turn, with strokes and word |

**The replay data was already being stored.** `roundRepository.finish` writes
the finished board to `rounds.snapshot` in one write at turn end — live strokes
never touch Mongo — so this feature adds nothing to the drawing path. What it
adds is a budget on that write, and a way to read it back.

**A live turn is never served.** A replay carries the drawing *and* the word,
so `replayService` refuses anything whose `endedAt` is unset — with the same
`NOT_FOUND` a turn that never existed gets, so the endpoint cannot be used to
probe for which turn is live.

The list carries no strokes. A twelve-turn match's drawings together are
megabytes; the list is a menu, and the strokes come from the second call once.

**Storage budget** (`REPLAY_LIMITS`, enforced on the write by
`compactSnapshot`): 12,000 points per snapshot, 600 per stroke, 1,200 strokes.
When a drawing is over budget it loses **points, not strokes** — dropping a
stroke removes something the drawer drew, while dropping every other point
within one removes only smoothness the renderer's curve-smoothing puts back.
Thinning is evenly spaced and pins each stroke's endpoints, and the two-point
floor means a `line`, `rectangle` or `circle` can never be thinned below its own
geometry. Only past the stroke ceiling — which no human drawing reaches — is
content discarded, and then the earliest strokes are kept so what survives is
still a drawing in progress.

`RoundResultDto` now carries `gameId` and `turnNumber`, which is how a client
names a replay: nothing in the protocol ever puts a round document id on the
wire. They ride on the round result rather than the game state because that is
the exact moment a replay becomes available, and a round result is sent once per
turn where game state is sent on every hint and score change.

**Timing is derived, not stored.** Strokes carry a `ts`; points inside them do
not, and adding one would have meant a third number on the highest-frequency
payload in the game to serve a screen nobody looks at during play. So playback
advances through the *drawing* — every point takes the same slice of time, with
a short beat between strokes — rather than reproducing the drawer's exact
hesitations.

### XP, levels and achievements

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/progression/me` | The caller's level plus the whole catalogue |
| `GET` | `/api/achievements?userId=` | Any player's unlocks; defaults to the caller |
| `GET` | `/api/progression/xp?page=&limit=` | The caller's own XP history |

**Every route here is a read, and that is the design.** XP is awarded by the
game engine from facts it owns; achievements unlock as a consequence. There is
no endpoint through which a client sends a level, an amount or an unlock, so
there is nothing for a modified client to forge.

`XP_AWARDS` in `progression.constants.ts` is the only place an amount comes
from. A caller of `xpService.award` names a *reason* and a count; the rate is a
constant.

**Levels** are `xpForLevel(n) = round(100 · (n-1)^1.6)`, capped at 50.
`levelForXp` inverts it, then corrects against `xpForLevel` itself — the
closed-form inverse disagrees at the boundaries because `xpForLevel` rounds,
and a player holding exactly a threshold would otherwise read one level low.
`users.xp` is the authority; `users.level` is denormalised beside it so the
database can sort by level without recomputing a power function per row.

**Achievements never pay twice.** Two things make that true together, and
neither is sufficient alone:

1. The watched counters only ever increase, so a threshold once crossed stays
   crossed and re-evaluating is idempotent.
2. `{userId, key}` is unique on `achievements`. The insert *is* the claim —
   there is no read-then-write check to lose a race — and only the caller whose
   insert succeeded pays the XP and sends the notification.

**Abandoned games pay nothing**, and mostly by construction rather than by a
check: the per-match tally lives on the in-memory seat (`RuntimePlayer.matchStats`)
and dies with the room, so a match that never reaches `endGame` never reaches
the progression service at all. What `isRankedMatch` adds is the match that did
end but should not count — fewer than `MIN_PLAYERS_TO_START` players, or zero
turns begun.

XP history rows carry a 90-day TTL. They are a *log* that explains a balance,
never the balance itself: summing them would make every profile read an
aggregation and would go wrong the moment a row expired.

### Tournaments

Three knockout tournaments run at all times, organised entirely by the server.
There is no admin, and there is no create endpoint — not gated, *absent*.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/tournaments` | The three slots, in order. An empty slot is a row with `tournament: null`. |
| `GET` | `/api/tournaments/active` · `/upcoming` | Narrower reads of the same rows |
| `GET` | `/api/tournaments/:id` | One tournament, with the caller's own `viewer` state |
| `POST` · `DELETE` | `/api/tournaments/:id/register` | Join; withdraw (registration window only) |
| `POST` | `/api/tournaments/:id/check-in` | Confirm you are present, before the draw |
| `GET` | `/api/tournaments/:id/participants` · `/bracket` · `/leaderboard` | Roster, draw, placements |
| `POST` | `/api/tournaments/:id/matches/:matchId/enter` | The room code for *your* match |
| `POST` | `/api/internal/tournaments/scheduler` | One scheduler tick, secret-gated |
| `GET` | `/api/tournaments/events` | The older *points* tournaments, which moved off the bare path |

**A tournament match is an ordinary room.** The bracket creates one with
`allowedUserIds` set to the two participants, the existing engine plays it, and
`endGame`'s standings *are* the result. There is no second game engine and no
second scoring path.

**AI players fill a short roster**, never a seat a person would have had, and
never a whole tournament: `minHumanPlayers` is checked before any arithmetic, so
a bot-only tournament cannot be produced. Bots draw through `drawingService` and
guess through `submitGuess` — the same code a person's packets go through — and
are excluded from every durable write at the end of a match, so none of them
ever reaches a leaderboard.

**The guessing code cannot reach the answer.** Its only input is the same
`serializeGameState(room, botId)` payload a human guesser receives, in which
`word` is `null`. It guesses from the blanks and from coarse statistics of the
shared canvas.

"Exactly three, never four" is a partial unique index on `slotNumber`, not a
count — so two schedulers racing produce one tournament and a duplicate-key
error, with no window between a read and a write.

Full write-up, including the socket events, the difficulty table, the deployment
options and the known limitations: **[`docs/AUTOMATIC_TOURNAMENTS.md`](docs/AUTOMATIC_TOURNAMENTS.md)**.

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
| `c:room:quickPlay` | `{profile}` | Acks `{room, created, alreadySeated}`. Matchmakes and seats in one round trip |
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
| `c:voice:join` | `{}` | Acks the caller's voice state. **Refused for the drawer** |
| `c:voice:leave` | `{}` | Always allowed, drawer included |
| `c:voice:offer` | `{targetId, description}` | Guesser → guesser only |
| `c:voice:answer` | `{targetId, description}` | Guesser → guesser only |
| `c:voice:ice` | `{targetId, candidate}` | Guesser → guesser only |
| `c:voice:mute` | `{muted}` | Advisory; the track is disabled on the sender's device |

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
| `s:voice:state` | `{enabled, isDrawer, phase, muted, peers, iceServers}` — **per recipient** |
| `s:voice:peerJoined` | `{peer}` — voice group only, so never the drawer |
| `s:voice:peerLeft` | `{userId, reason}` — voice group only |
| `s:voice:offer` / `answer` / `ice` | `{from, description \| candidate}` — to one peer's socket |
| `s:voice:mute` | `{userId, muted}` — voice group only |
| `s:voice:error` | `{code, message}` — e.g. `DRAWER_VOICE_DISABLED` |
| `s:friend:requestReceived` | `{requestId, user}` — to the receiver |
| `s:friend:requestAccepted` | `{requestId, user}` — to the original sender |
| `s:friend:requestRejected` | `{requestId, user}` — to the original sender |
| `s:friend:requestCancelled` | `{requestId}` — to the receiver |
| `s:friend:removed` | `{user}` — to the other party |
| `s:friend:blocked` / `unblocked` | `{user}` — **to the blocker only** |

### Friend events

Addressed to a *player* rather than a room: they go out on `userChannel`, so
they arrive on every device that person is signed in on and whether or not they
are in a game.

Each is emitted twice — once as `s:friend:*` above, once under the flatter
`friend:request_received` / `friend:removed` spelling. Same payload, same
channel, so a client written against either vocabulary works and neither has to
be migrated. A client listens for one set or the other, never both.

They carry a public card and an id, and nothing else. **They are a nudge to
refresh, not a transport**: the authoritative lists come from REST, and the
Flutter client folds every one of these into a re-read rather than parsing list
entries out of them. Missing one therefore costs a refresh and nothing more,
which matters because the realtime server may be deployed separately and may be
restarting.

Note what is absent: nothing is sent to the person who was *blocked*, because
being told would be exactly the disclosure the feature avoids. The one thing
they can observe is a friendship that quietly ended — unavoidable, since the
friend is simply not in their list any more.

### Notification events

| Event | Alias | Carries |
|---|---|---|
| `s:notification:new` | `notification:new` | The full row plus `unreadCount` |
| `s:notification:unread` | `notification:unread` | `unreadCount` only |

Addressed to a *player*, like the friend events above, and emitted under both
vocabularies for the same reason.

These are **additional** to the friend and invitation events, not a replacement
for them. A friend request now emits `s:friend:requestReceived` *and*
`s:notification:new`: the first tells a friends screen its cached list is
stale, the second tells the badge its count changed. A client showing the
friends screen acts on one; a client on the home screen acts on the other.
Collapsing them would mean inferring every badge update from every domain event
a client happens to know about — which is exactly the fan-out the notifications
collection exists to centralise.

`s:notification:new` carries the row so a toast can be drawn without a round
trip. `s:notification:unread` deliberately does not: it fires when *this*
player reads or deletes something on another device, and it exists so clearing
a badge on a phone clears it on the tablet too.

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

### Tools

`t` is one of `pen`, `pencil`, `marker`, `brush`, `eraser`, `fill`, `line`,
`rectangle`, `circle`. An unrecognised value becomes `pen` rather than a
refusal: a client from a later release should still put a mark on the board,
and a drawer whose strokes silently vanish for everybody is far worse than one
drawn with the wrong nib.

**Every tool is still a stroke.** A rectangle is two points and a tool name; a
fill is a colour and a tool name. None of them is a special message — all go
down the same `begin/append/end` path, land in the same append-only
`board.strokes`, and are undone by the same `undo`. That is what keeps one
ordering rule, one replay and one redo stack for the whole feature.

Three families, and the server bounds each:

| Family | Tools | Points | Enforcement |
|---|---|---|---|
| Freehand | `pen` `pencil` `marker` `brush` `eraser` | streamed | capped at `maxPointsPerStroke` |
| Shape | `line` `rectangle` `circle` | exactly 2 | trimmed on `begin`, `append` refused |
| Fill | `fill` | 1, unused | trimmed on `begin`, `append` refused |

The `append` refusal matters as much as the trim: they are separate entry
points, so trimming only on `begin` would leave a client free to stream four
hundred points into a "rectangle" afterwards.

**`fill` covers the whole canvas, not an enclosed region**, and that is a
deliberate limitation. A region flood fill is a pixel operation — it needs a
rasterised bitmap to walk, and every client here rasterises at a different size
with different anti-aliasing. The same fill would spill past a hand-drawn gap on
a tablet and stop at it on a phone, so the shared canvas would stop being
shared; worse, the turn-end snapshot is a list of strokes rather than an image
and could not record which happened. A whole-canvas fill replays identically
everywhere, at any resolution, from two numbers.

### Pressure

A point is `[x, y]`, or `[x, y, pressure]` where a device reports one, with
pressure normalised to `0..1`. Only `brush` varies its width with it, so **only
`brush` strokes carry the third element** — points are the highest-frequency
payload in the game, and a third number on every one of them would be a 50%
increase on the thing sent most often.

That also makes it compatible in both directions: an older client sends two
elements and is read correctly, and a newer client's third element is ignored by
an older server.

---

## Voice chat

Guessers talk to each other over WebRTC while somebody draws. The drawer can
neither speak nor hear.

### What this server carries

Signalling, and nothing else: SDP offers, SDP answers and ICE candidates. The
audio is a peer-to-peer stream between players' devices that never reaches this
process, never travels over Socket.IO and is never written to MongoDB. A room
of six costs the server a few dozen small messages per turn.

That is what makes the feature free to run, and it is why it needs no media
server, no SFU and no paid SDK.

### The rule, and where it is enforced

```
Round 1 — A draws            Round 2 — B draws
  B ↔ C   B ↔ D   C ↔ D        A ↔ C   A ↔ D   C ↔ D
  A: no connections            B: no connections
```

The drawer is not merely hidden from the UI. They are never admitted to the
voice group, no peer is ever handed their id, and every `c:voice:*` frame from
or to them is refused:

```jsonc
{ "ok": false,
  "error": { "code": "notDrawer",
             "message": "Voice chat is off while you are drawing.",
             "details": { "code": "DRAWER_VOICE_DISABLED" } } }
```

`voice.service.ts` checks all of it against state this process owns: the caller
is in the room, is connected, is **not** `room.round.drawerId`, the phase is one
where voice is open, and — for signalling — the target is in the room, in the
voice group, and not the drawer either.

`c:voice:leave` is the deliberate exception and is always allowed. A client
that has just been made drawer calls it to comply, and refusing that would
strand a well-behaved client holding a connection it was told to drop.

The voice fan-out uses its own Socket.IO channel (`voice:<roomId>`) rather than
the room channel, so "the drawer cannot hear anybody" holds at the transport
level and not only in the handlers.

### How membership stays correct

`gameService.broadcastState` calls `voiceService.reconcile`, and that is the
only hook. Every state change already funnels through that broadcast — a turn
opening, the pen changing hands, a pause, a resume, a departure, a reconnect —
so there is no list of call sites that each have to remember to hang the old
drawer up. `reconcile` re-derives who belongs in voice, evicts anybody who does
not, and pushes `s:voice:state` to the evicted socket directly. It returns
immediately for a room with an empty voice group, which is every room outside a
turn.

Voice is open during `word_selection`, `drawing` and `round_result`, and closed
in the lobby, the starting countdown, a paused match and the final scoreboard.

### Mesh, not mixer

Rooms are small, so every guesser holds one peer connection to every other
guesser. At six players that is five connections per device, which a phone
handles comfortably. Who offers in a pair is settled by comparing player ids —
the lexicographically smaller one offers — so both ends reach the same answer
with no extra round trip, and neither glare nor a duplicate connection is
possible.

### STUN and TURN

`iceServers` is built from the `WEBRTC_*` environment and handed to clients
over `s:voice:state`. Nothing about STUN or TURN is compiled into the app,
which is what keeps a relay credential out of every installed APK and lets one
be rotated by restarting this process.

STUN alone is the default and is enough for the large majority of home and
mobile networks. TURN is the fallback for peers behind a symmetric NAT: it is
optional, it is not free — every byte of audio is relayed — and with none
configured such a pair simply fails to connect while the rest of the mesh
carries on.

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

### Friends, blocks and leaderboards

Same rule, applied to the social features: the client is never trusted for
score, rank, locality, friendship status or block status.

- **The only id a caller ever supplies about another player is that player's
  id.** No endpoint accepts a `senderId`, an owner, a relation or a score — the
  actor is always the token. A body that spells `senderId` has the key stripped
  by Zod and changes nothing.
- **A request id is not a capability.** Accept, reject and cancel each check
  the caller against the loaded row, so guessing an id gets a refusal rather
  than somebody else's friendship.
- **Duplicate prevention is an index, not a check.** A partial unique index on
  the sorted `pairKey` lets exactly one pending request exist between two
  people in *either* direction. The service reads first to produce a good
  message, but the index is what makes the rule true when two people tap "Add
  friend" on each other in the same instant.
- **Resolving a request is a conditional update.** `{_id, status: pending}` in
  the filter means a double-tap, or an accept racing a cancel, matches once;
  the loser is told the request was already handled rather than performing the
  action twice.
- **Blocking is written before it cascades**, so every gate is already refusing
  before the friendship is torn down. A block placed *after* a request was sent
  still wins: accepting into one is refused and the request is cancelled.
- **Locality cannot hold an address.** The schema has fields for a city, a
  region and a two-letter country code and nothing else — the same structural
  refusal `updateProfile` makes for scores. A write that cannot be expressed
  cannot be made.
- **Blocked users are excluded from search, leaderboards and matchmaking**, and
  the block is never disclosed to the person it was placed on: their view of a
  profile is identical to a stranger's.
- Paging is bounded at both ends (`limit` ≤ 100, `page` ≤ 400) so an
  unbounded skip cannot be used to make the server do arbitrary work.
- Sending a friend request and searching users have their own rate-limit
  buckets — the first because it puts a notification in a stranger's list, the
  second because an anchored case-insensitive match cannot seek in the index.

**Leaderboard scores come only from finished games.** Nothing in the
leaderboard path writes; every number it reads was put on a user row by
`recordGameResult`, which only the end-of-match path calls.

---

## Testing

```bash
npm test                # unit tests, no database required
npm run test:e2e        # the full game, three real clients, needs a running server
npm run test:e2e:voice  # 37 voice checks, three real clients, needs a running server

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

`tests/matchmaking.test.ts` covers Quick Play eligibility and ordering as pure
functions of a room and a user: private, full, in-progress, finishing, closed,
banned, already-seated and blocked rooms are each rejected by name, a paused
room is accepted (it is waiting for exactly that player), and ranking prefers
the fullest room with ties broken by age so the order is deterministic.

`tests/social.test.ts` covers the friend and leaderboard rules that need no
database: pair normalisation producing one key from either direction and never
colliding across pairs, locality keys folding case and punctuation while
keeping same-named towns in different countries apart, win-rate arithmetic,
rank-change staying `null` without history, paging clamped at one end and
refused at the other, and the validators — including that the send-request body
has no field for a sender and the locality body has none for an address.

What is *not* simulated: the partial unique index that refuses a mirrored
pending request, and the `status: pending` guard that makes a double Accept a
no-op. Both are enforced by MongoDB, and a test that faked them would be a test
of the fake. Exercise them against a real database:

```bash
npm run sync-indexes    # required once after pulling these models

# Two accounts, A and B. With A's token:
curl -XPOST $API/api/friends/requests -d '{"receiverId":"<B>"}'   # 201
# Now with B's token — the mirrored request:
curl -XPOST $API/api/friends/requests -d '{"receiverId":"<A>"}'   # 409 INVALID_ACTION
# And accept it twice from B:
curl -XPOST $API/api/friends/requests/<id>/accept                 # 200
curl -XPOST $API/api/friends/requests/<id>/accept                 # 409, not a second friendship
```

`npm run test:e2e` walks the brief's Definition of Done with three
authenticated clients over a real websocket: guest login → create → join by
code → ready → start → server picks the drawer → drawer gets words → **other
players do not** → drawing relays → non-drawer refused → guessing → scoring →
duplicate guess refused → timer ends → answer revealed → next drawer → final
result → play again.

`npm run test:e2e:voice` is the security test for voice chat, run the way an
attacker would. It emits `voice:join`, `voice:offer`, `voice:answer` and
`voice:ice_candidate` straight from the drawer's socket — under both the
canonical `c:voice:*` names and the shorter aliases — and checks every one
comes back `DRAWER_VOICE_DISABLED`. Then the positive half: two guessers join,
exchange an offer, an answer and a candidate, and see each other's mute state,
while the drawer's socket receives no voice traffic at all. Finally it waits for
the turn to end and checks that the pen moving flips both players' permission —
the previous drawer may speak, the new one may not.

It accepts `API_URL` and `SOCKET_URL` separately, so it can be pointed at a
locally rebuilt realtime server while another process keeps serving REST.

Voice *audio* is not covered by any automated test, and cannot be: hearing
somebody needs two real devices. The manual matrix is three clients with one
drawing — check the drawer hears nobody and nobody hears the drawer, then mute,
unmute, drop one client's network, and let the turn roll over.

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
