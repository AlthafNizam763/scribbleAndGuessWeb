# Automatic tournaments, with AI players

Three knockout tournaments run at all times. Nobody creates them, nobody
administers them, and nobody fills them — the server does all three. A player's
entire vocabulary is **join**, **check in**, and **enter my match**.

When a tournament is short of players, the server seats AI bots that play the
real game: they pick a word, draw it stroke by stroke over the existing drawing
protocol, guess through the existing guess validator, score under the existing
scoring rules, win, lose, and advance through the bracket.

---

## 1. The shape of it

```
  scheduler tick (every 15s, or an external cron)
        │
        ├─ fill vacant slots ─────────► AutoTournament (UPCOMING)
        ├─ open registration ─────────► REGISTRATION   ── players join
        ├─ registration deadline ─────► CHECK_IN       ── players confirm
        ├─ check-in deadline ─────────► bot fill → bracket → RUNNING
        ├─ match entry deadlines ─────► walkovers
        └─ round progression ─────────► COMPLETED / CANCELLED → slot released
                                                                   │
                                                    next tick refills the slot
```

A match is an **ordinary room**:

```
  TournamentMatch ──roomId──► Room (protected: allowedUserIds = the two players)
                                │
                                ├─ human joins over c:room:join
                                ├─ bot is seated by the server (no socket)
                                └─ gameService.startGame → the existing engine
                                        │
                                        └─ endGame → onMatchGameEnded → bracket
```

There is no second game engine, no second scoring path and no second way into a
game. A tournament result is whatever `gameService.endGame` computed.

---

## 2. The three-slot rule

"Exactly three tournaments, never four" is **a unique index**, not a count:

```js
// models/AutoTournament.ts
autoTournamentSchema.index(
  { slotNumber: 1 },
  { unique: true,
    partialFilterExpression: { status: { $in: ['UPCOMING','REGISTRATION','CHECK_IN','RUNNING'] } } },
);
```

Two schedulers racing to fill slot 2 both insert; one wins, the other gets a
duplicate-key error and moves on. There is no read-then-write, so there is no
window. The partial filter is what lets a slot be reused for ever without the
index reserving it against every tournament that ever ran in it.

`tournamentNumber` is separately unique for all time, so "Daily Scribble Cup #7"
names one event even though slot 2 has held dozens.

---

## 3. When AI players are added

Decided by `TournamentBotFillService.plan`, at **check-in close** — not at
registration close, because the number that matters is how many people are
actually present.

| Humans present | Bots added | Outcome |
|---|---|---|
| 4 | 0 | 4 humans play |
| 3 | 1 | 4 players |
| 2 | 2 | 4 players |
| 1 | 3 | 4 players |
| 0 | — | **cancelled** |
| 6 | 0 | 6 humans play (no top-up) |
| 2, `maxBots=0` | — | cancelled |

Two rules that fall out of this and are worth stating plainly:

- **A bot-only tournament is impossible.** `minHumanPlayers` is checked before
  any arithmetic, so no combination of bots routes around it.
- **A maximum is a ceiling, not a quota.** Nothing fills a 16-player tournament
  with 16 bots because it *can* hold 16. The target is always `minPlayers`.

---

## 4. The AI players

Six fixed profiles (`Scribbler`, `Sketcher`, `Doodler`, `GuessMaster`,
`Pixeler`, `QuickDrawer`), each with a stored row giving it a stable ObjectId to
play under. Three difficulties change *rates*, never rules:

| | guess delay | guess accuracy | stroke interval | template completeness | hand jitter |
|---|---|---|---|---|---|
| EASY | 8–15 s | 0.35 | 260 ms | 70 % | 0.030 |
| NORMAL | 4–10 s | 0.55 | 180 ms | 90 % | 0.018 |
| HARD | 2–6 s | 0.78 | 120 ms | 100 % | 0.008 |

### Drawing

`botDrawer.service.ts` turns a hand-specified template into a **plan**: a list
of `begin` / `append` / `end` steps with delays. `botPlayer.service.ts` runs the
plan through `drawingService.begin/append` and the `s:draw:*` broadcasts — the
same code a person's packets go through, so a bot's stroke is sanitised, stored
and relayed identically. The plan is paced to finish with a quarter of the turn
to spare, because a drawing still being drawn at the buzzer helped nobody.

Templates exist for: apple, banana, orange, house, car, tree, cat, dog, book,
phone, flower, boat, sun, moon, star, umbrella, bicycle, computer, chair, pizza.
An unknown word draws a neutral fallback and logs the gap — **never** throws,
never stalls the round.

### Guessing — and the rule that shapes it

**The guessing code cannot reach the answer.** `botGuesser.service.ts` takes one
input type:

```ts
interface GuesserView {
  maskedWord: string;      // `_ _ E _ _`
  wordLength: number;
  hintIndices: readonly number[];
  strokes: readonly StrokeDto[];   // the shared board
  progress: number;
}
```

That object is built by the same `serializeGameState(room, botId)` that fills a
human guesser's `s:game:state`, and `word` is `null` in it because the bot is
not the drawer. There is no argument, no import and no service call through
which the answer could arrive.

So how does it ever guess right? The same two ways a person does:

1. **The blanks.** Length and revealed letters exclude most of the pool exactly.
2. **The drawing, coarsely.** Stroke count, ink colours, bounding box, vertical
   balance and mean stroke length — all derived from the shared canvas — are
   compared against the same statistics computed from the bot's own template
   library. A drawing that is mostly yellow radiating lines looks unlike a
   single dark outline. It is a deliberately weak signal, and it is why a HARD
   bot beats an EASY one on the same masked word.

`accuracy` is the chance one attempt is drawn from the best-matching candidates
rather than from all of them. It is never a short-circuit to the answer.

### Worker safety

Every bot timer is registered in one map keyed by room. Cleared on turn end,
match end and room close. Bounded globally by `maxConcurrentWorkers` (24) — a
bot refused a slot simply does nothing that turn and is still in the match.
Exposed as the `botWorkers` gauge on `/api/metrics`.

---

## 5. API

Every route is under `/api/tournaments`. Reads marked *public* work signed out;
the `viewer` block is then the anonymous one.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/tournaments` | *public* — the three slots, in order. An empty slot is a row with `tournament: null`. |
| GET | `/api/tournaments/active` | *public* — tournaments being played. |
| GET | `/api/tournaments/upcoming` | *public* — tournaments still joinable. |
| GET | `/api/tournaments/:id` | *public* — one tournament. Falls through to the older points events when the id is one of those. |
| POST | `/api/tournaments/:id/register` | Take a place. Duplicate = no-op. |
| DELETE | `/api/tournaments/:id/register` | Withdraw. Registration window only. |
| POST | `/api/tournaments/:id/check-in` | Confirm you are here. Check-in window only. |
| GET | `/api/tournaments/:id/participants` | *public* — everybody, AI flagged. |
| GET | `/api/tournaments/:id/bracket` | *public* — the draw. Room codes only on your own matches. |
| GET | `/api/tournaments/:id/leaderboard` | *public* — placement table. |
| POST | `/api/tournaments/:id/matches/:matchId/enter` | The room code for your match. Participants only. |
| POST | `/api/internal/tournaments/scheduler` | One scheduler tick. Secret-gated. GET also accepted. |
| GET | `/api/tournaments/events` | The older *points* tournaments (moved from `/api/tournaments`). |

**Not present, by design:** `POST /api/tournaments/create`,
`POST /api/user/tournaments`, and anything that adds a bot, changes settings,
edits a bracket or reports a result. Those are not gated — they do not exist.

### Refusals worth knowing

| Situation | Status | Message |
|---|---|---|
| Already in another tournament | 409 | `You are already in Daily Scribble Cup #4. You can join another once it finishes.` |
| Registration closed | 409 | `Registration has closed for this tournament.` |
| Tournament full | 409 | `That tournament is full.` |
| Check-in not open yet | 409 | `Check-in has not opened yet.` |
| Not a participant of a match | 404 | `That match does not exist.` |
| Scheduler without the secret | 401 | `Not authorised.` |

The listing pre-computes the first of these into
`viewer.blockedReason`, so the UI can explain it *before* somebody taps.

### The `viewer` block

```jsonc
{
  "isRegistered": true,
  "isCheckedIn": false,
  "canRegister": false,
  "canCheckIn": true,     // draw the Check In button
  "canWithdraw": false,
  "blockedReason": null,
  "activeMatch": { "matchId": "...", "roomCode": "AB12C", "entryDeadlineMs": 1700000090000 }
}
```

Computed server-side because the rules behind it are server rules. A client that
re-derived them would be a second implementation that could disagree, and the
disagreement would look like a button that does nothing.

---

## 6. Socket events

All under two names — `s:tournament:x` and the flatter `tournament:x` — so a
client written against either vocabulary works.

**Subscription:** `c:tournament:watch` / `c:tournament:unwatch`. Membership is
per *connection* and does not survive a reconnect, so clients re-send on
`connect`. Without that a tab goes quiet after its first dropped connection and
the symptom is indistinguishable from a quiet hour.

| Event | Sent to | Carries |
|---|---|---|
| `tournament:created` | lobby | slot, number, name |
| `tournament:registration_opened` | lobby | deadline, sizes |
| `tournament:registration_updated` | lobby | human/bot/total counts |
| `tournament:checkin_opened` | lobby | deadline, registered humans |
| `tournament:checkin_closed` | lobby | final counts |
| `tournament:started` | lobby | rounds, players |
| `tournament:bracket_updated` | lobby | match/round |
| `tournament:match_ready` | **the two players only** | room code, entry deadline |
| `tournament:match_started` | lobby | round, match |
| `tournament:match_completed` | lobby | winner, outcome, scores |
| `tournament:round_completed` | lobby | round number |
| `tournament:completed` | lobby | winner |
| `tournament:cancelled` | lobby | reason |
| `tournament:next_scheduled` | lobby | the replacement in a released slot |
| `tournament:bot_added` | lobby | bot id, difficulty |
| `tournament:bot_status_updated` | lobby | bot state |

Bot gameplay reuses the existing events verbatim — `s:draw:begin`,
`s:draw:append`, `s:draw:end`, `s:chat:message`, `s:game:roundStart`,
`s:game:roundEnd`, `s:game:end`. A client cannot tell a bot's stroke from a
person's, which is the point: it goes through the same relay.

---

## 7. Environment

```bash
TOURNAMENT_SLOT_COUNT=3              # the product rule
TOURNAMENT_MIN_PLAYERS=4
TOURNAMENT_MAX_PLAYERS=16            # a ceiling, not a quota
TOURNAMENT_MIN_HUMAN_PLAYERS=1       # makes a bot-only tournament impossible
TOURNAMENT_MAX_BOTS=3
TOURNAMENT_ALLOW_BOTS=true
TOURNAMENT_BOT_DIFFICULTY=NORMAL     # EASY | NORMAL | HARD
TOURNAMENT_REGISTRATION_MINUTES=10
TOURNAMENT_CHECKIN_MINUTES=2
TOURNAMENT_SCHEDULER_ENABLED=true    # false when an external cron drives it
TOURNAMENT_SCHEDULER_SECRET=         # required in production
```

Values are **copied onto each tournament at creation**, so a tournament already
taking registrations keeps the rules it advertised even if the deployment is
reconfigured mid-window.

---

## 8. Deployment

**Option 1 — in-process loop** (`TOURNAMENT_SCHEDULER_ENABLED=true`). The
realtime process ticks every 15 s. Started from `attachSocketServer`, so it runs
wherever the rooms are — a scheduler in a process with no socket server would
open match rooms nobody could join.

**Option 2 — external cron.** Set `TOURNAMENT_SCHEDULER_ENABLED=false` and:

```bash
curl -X POST https://your-host/api/internal/tournaments/scheduler \
  -H "x-scheduler-secret: $TOURNAMENT_SCHEDULER_SECRET"
```

Both at once is safe. Every tick takes the same distributed lock, so a migration
from one to the other needs no coordination.

**After deploying, sync the indexes.** They are not an optimisation — they are
what enforces the slot rule, the duplicate-registration rule and the
one-match-per-bracket-position rule:

```bash
npm run sync-indexes
```

### The lock

One row, `tournament_scheduler_locks`, taken with a single `findOneAndUpdate`
filtered on the lease being absent or expired. Mongo applies that atomically, so
of two processes trying at the same instant exactly one comes back with a
document. The 90-second lease is what recovers from a process that died
mid-tick; release is best effort, because if it never runs the lease expires
anyway.

---

## 9. Security

| Rule | How it is enforced |
|---|---|
| Only the backend creates tournaments | No route exists. `createdByType` has one legal value. |
| Only the backend creates bot registrations | `botProfileService` is imported by no handler. |
| Clients cannot impersonate a bot | `seatBot` is unreachable from any handler; bots hold no socket. |
| Clients cannot set `playerType` / `isBot` | Never read from a payload; set by `seatBot` alone. |
| Clients cannot set scores or winners | The engine computes both; the bracket copies the engine's standings. |
| Guessers cannot reach the answer | `serializeGameState` nulls `word` for non-drawers; the bot guesser's only input type has no field for it. |
| Outsiders cannot enter a match | `room.allowedUserIds`, checked before anything else in `joinRoom`. Refused as 404, so a guessed code confirms nothing. |
| Match codes are not broadcast | Blanked in `toMatchDto` for non-participants. |
| No duplicate registrations | Two partial unique indexes. |
| One tournament per player | Indexed query on `{userId, status}` at registration. |
| Bots are off every human leaderboard | `endGame` filters `humanStandings` before every durable write. |
| Bots have no voice | Tournament match rooms set `voiceEnabled: false`; a 1v1 drawer may never use voice anyway. |

---

## 10. Testing

```bash
npm run test           # 519 tests, 24 files
```

| File | Covers |
|---|---|
| `tests/botFill.test.ts` | Every fill case, including the cancel paths and the ceilings. |
| `tests/botPlayer.test.ts` | Guesser inputs, mask filtering, difficulty, drawing plans, template coverage. |
| `tests/botMatch.test.ts` | The driver: word selection, strokes reaching the board, guesses reaching the engine, and timer cleanup. |
| `tests/autoTournament.test.ts` | Against a real mongod: slots, concurrency, the lock, registration rules, check-in, bot fill, bracket shape, byes, advancement idempotency, completion, and what a client is shown. |

The database-backed file is the one that matters most: "never a fourth
tournament" is a partial unique index, "a winner is never advanced twice" is a
filter on a slot still being null. Neither can be demonstrated against a mock.

### Two bugs the tests found

1. **Compound `sparse` indexes do not skip null components.** The registration
   uniqueness indexes were sparse; because every row has a `tournamentId`, every
   row was indexed — so the second human in a tournament collided with the first
   on `{tournamentId, botId: null}`. The symptom was a tournament that silently
   admitted exactly one player and one bot. Fixed with
   `partialFilterExpression`.

2. **A bot picked a word and then never drew.** Word selection and drawing are
   both work for the same seat in the same round, and the "already running?"
   check matched on seat and round alone — so the finished selection task made
   the drawing look like work already under way. Only an end-to-end run found
   it, because every unit test set the phase to `drawing` directly. Fixed by
   giving each task a kind.

A third was found the same way: `wordService.pool` returns empty on an unseeded
word bank while the *drawer's* word comes from a built-in fallback, so a bot
would silently say nothing all turn. `guessablePool` now applies the same
fallback, in one place.

---

## 11. Known limitations

- **The bot does not see the drawing.** It compares coarse statistics of the
  board against its own template library. On a large seeded word bank that is a
  weak signal and most correct guesses come from mask filtering late in a turn.
  On a small bank (or the unseeded fallback) bots guess well — as the end-to-end
  run showed, where a bot won turns off a blank canvas because ten candidates
  filtered to one.
- **Bot drawings are a fixed library of twenty words.** Anything else draws a
  neutral fallback, which is unguessable by design. Worth extending from the
  `bot drawing fell back to a generic template` log line.
- **Brackets do not survive a process restart mid-match.** The room's board and
  countdown only ever existed in memory. The match's entry deadline then decides
  it as a walkover or cancels it; the bracket itself is durable throughout.
- **Presence is process-local.** The walkover check reads `socketIds` from the
  in-memory registry, so under a multi-instance deployment a player connected to
  another instance could read as absent. A Redis adapter fixes this; the socket
  layer is already structured for one.
- **One lock for all tournaments.** Fine at three; a deployment running many
  slots would want per-tournament locks.
- **The three-slot listing is read on every tick by every viewer.** Backed by
  indexes and denormalised counts, but not cached — worth a short TTL cache if
  the tournament screen becomes the busiest in the app.

## 12. Possible next steps

- Seed drawing templates from the actual word bank rather than a fixed twenty.
- Per-tournament bot difficulty, so slot 3 can be the hard one.
- Spectating a tournament final — the room already supports spectators, it is
  only switched off for match rooms.
- A `tournament:standings` push so the bracket updates without a re-read.
- Redis adapter, which turns the presence limitation above into a non-issue and
  lets several instances share the socket fan-out.
