# Daily tournaments, with AI players

Three tournaments every day — morning, afternoon and evening. Nobody creates
them, nobody administers them, and nobody fills them: the server publishes the
schedule, seats AI players where a roster is short, draws the bracket and
decides the matches. A player's whole vocabulary is **join**, **check in** and
**enter my match**.

When a tournament is short of players, the server seats AI bots that play the
real game: they pick a word, draw it stroke by stroke over the existing drawing
protocol, guess through the existing guess validator, score under the existing
scoring rules, win, lose, and advance through the bracket.

---

## 1. The shape of it

```
  day rolls over (in TOURNAMENT_TIMEZONE)
        │
        └─ the organiser publishes today and tomorrow ── 3 per day, UPCOMING
                │
                │  (hours pass; the card shows a start time)
                │
   startAt-90m ─┼─► REGISTRATION ── players join; any of the day's three
                │
   startAt-10m ─┼─► CHECK_IN ────── registered players confirm they are here
                │
   startAt ─────┼─► no-shows out, bots take the empty seats, bracket drawn
                │
                └─► RUNNING ──► COMPLETED   (or CANCELLED, if nobody came)
                                   │
                                   └─ the card stays, showing the winner
```

Nothing is created to replace a tournament that ends. A daily slot is a date
and a time of day; when the morning tournament finishes, the morning is over.
The next tournament is the afternoon one, which has been on the schedule since
midnight.

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

## 2. "Three a day, never four"

It is **a unique index**, not a count:

```js
// models/AutoTournament.ts
autoTournamentSchema.index(
  { tournamentDate: 1, dailySlot: 1, isAutomatic: 1 },
  { unique: true, name: 'one_tournament_per_slot_per_day' },
);
```

Two schedulers racing to publish this evening's tournament both insert; one
wins, the other gets a duplicate-key error, logs it as the ordinary event it is,
and moves on. There is no read-then-write anywhere in `dailyPlanner.service.ts`,
so there is no window. Every one of these is the same case and needs no special
handling:

| Situation | What happens |
|---|---|
| Two cron requests arrive together | One insert wins, the other is refused |
| The server restarts | The next tick finds the day already published |
| A scheduler retries | Same |
| Several Render instances run | Same |
| The scheduler endpoint is called in a loop | Same |
| A tournament completes | Nothing is created; the slot is spent |
| A tournament is cancelled | Nothing is created; the slot is spent |

The constraint is **not** restricted to live statuses — that was the rolling
model's index, which had to be, because a slot came free the moment its occupant
ended. `{2026-09-16, MORNING}` names one event for all time.

> **Deploying this over the rolling version drops `one_live_tournament_per_slot`
> and builds the new index.** `npm run sync-indexes` does both. See §8.

### The day, and which one it is

A day is a `'YYYY-MM-DD'` string computed in `TOURNAMENT_TIMEZONE`, not a
`Date` and not the host's clock — see `utils/dayKey.ts`. Every instance asking
on the same wall-clock day gets the same ten characters, which is what makes the
index a constraint rather than a hope. It also sorts: chronological order is
lexicographic order, so "today's tournaments" is one indexed query.

### A slot that has already passed is not created

A deployment that first boots at nine in the evening does not publish that
morning's tournament. It could never have been joined, and creating it would
produce a card that exists only to be cancelled. That day has two tournaments,
or one; the next has three.

---

## 3. The names

Twenty names, three a day, from `TOURNAMENT_NAME_POOL`:

> Ink Royale · Doodle Rush · Sketch Clash · Scribble Storm · Canvas Kings ·
> Draw Duel · Pencil Panic · Sketch Masters · Ink Warriors · Doodle League ·
> Brush Battle · The Drawing Cup · Sketch Legends · Paper Champions ·
> The Scribble Cup · Creative Clash · Drawing Rivals · Masterpiece Match ·
> Ink Arena · Ultimate Doodle Cup

`TournamentNameService` picks them by **arithmetic on the date**, not by a
counter, a shuffle or a draw. Day *n* takes pool positions `3n, 3n+1, 3n+2`
(mod 20). That matters because two processes must be able to create the same
tournament without talking to each other: a retry, a second instance and a
restart all compute the same three names for the same day, for ever, with no
state to keep.

The rotation is what gives the guarantees rather than a runtime check:

- **Three different names a day** — three consecutive positions.
- **No name on two consecutive days** — the positions differ by 3, 4 or 5 and
  each day's set is two wide, so they cannot overlap.
- **Twenty days before a name returns** — 20 and 3 share no factor.

A name is written once, at creation, and **no code path writes it again**. That
is what makes "do not rename a tournament people have joined" a property rather
than a rule somebody has to remember. A winner's name never appears in a
tournament name; the winner is a separate field on the row.

---

## 4. One player, more than one tournament

**The rule that reversed.** The rolling system refused a second registration
while a first was live, because tournaments ran back to back and being in two
meant being called to two matches at the same moment.

Three tournaments hours apart are not that:

| | |
|---|---|
| Won the morning tournament | May join the afternoon and the evening |
| Lost the morning tournament | Same |
| Missed the morning entirely | May join the afternoon and the evening |
| Joined the morning | Is **not** registered for the others — each is joined separately |
| Joined the morning twice | One seat. The unique index makes the second a no-op |

Registration is per tournament and unlimited. The only cross-tournament rule
left is at the door of the **match**, not the tournament: `match.service.enter`
refuses a player who is already in a `RUNNING` match elsewhere, because the game
engine seats one player in one room. Under the published schedule that almost
never fires — the slots are hours apart — and it exists for the case where a
bracket over-runs into the next one.

---

## 5. The winner, and where it is shown

When the final is decided, `finish()` writes the result **onto the tournament**
in one conditional update:

```
winnerRegistrationId, winnerUserId, winnerDisplayName,
winnerAvatarId, winnerAvatarColorIndex, winnerIsBot,
finalRankings[], completedAt
```

A snapshot, not a join. A player who wins tonight and renames themselves next
week did not win under the new name — and a card that re-read their profile
would say they did, silently rewriting every result they have ever been part
of. `finalRankings` freezes the whole placement table for the same reason.

The update names the status it expects to replace, so a duplicate result, a
retried sweep or two schedulers reaching the final together produce **one**
winner and one `completedAt`.

Every tournament's winner is on its own document and its own DTO. There is no
ambient "latest winner" anywhere in the codebase, so there is nothing for a
card to leak: `tournament:completed` carries a `tournamentId`, and a client that
keys on it cannot paint the morning's winner onto the afternoon's card.

---

## 6. API

Every route is under `/api/tournaments`. Reads marked *public* work signed out;
the `viewer` block is then the anonymous one.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/tournaments` | *public* — today's tournaments, at most three, in the order they happen. |
| GET | `/api/tournaments/today` | *public* — the same, at a path that says so. `?date=YYYY-MM-DD` for another day. |
| GET | `/api/tournaments/active` | *public* — tournaments being played. |
| GET | `/api/tournaments/upcoming` | *public* — scheduled, open or in check-in, across days, by start time. |
| GET | `/api/tournaments/:id` | *public* — one tournament and its own result. Falls through to the older points events when the id is one of those. |
| POST | `/api/tournaments/:id/register` | Take a place **in that tournament only**. Duplicate = no-op. |
| DELETE | `/api/tournaments/:id/register` | Cancel a registration. Registration window only. |
| POST | `/api/tournaments/:id/check-in` | Confirm you are here, for that tournament only. |
| GET | `/api/tournaments/:id/participants` | *public* — everybody, AI flagged. |
| GET | `/api/tournaments/:id/bracket` | *public* — that tournament's draw. Room codes only on your own matches. |
| GET | `/api/tournaments/:id/leaderboard` | *public* — that tournament's placement table; the frozen one once it has finished. |
| POST | `/api/tournaments/:id/matches/:matchId/enter` | The room code for your match. Participants only. |
| POST | `/api/internal/tournaments/scheduler` | One scheduler tick. Secret-gated. GET also accepted. |
| GET | `/api/tournaments/events` | The older *points* tournaments. |

**Not present, by design:** `POST /api/tournaments/create`,
`POST /api/user/tournaments`, `POST /api/admin/tournaments`, and anything that
adds a bot, changes settings, edits a bracket or reports a result. Those are not
gated — they do not exist.

The day listing is shaped as a day rather than a bare list:

```jsonc
{
  "tournamentDate": "2026-09-16",
  "timeZone": "Asia/Kolkata",     // what "20:00" on these rows means
  "tournaments": [ /* ≤ 3, in slot order */ ]
}
```

### Refusals worth knowing

| Situation | Status | Message |
|---|---|---|
| Registration has not opened | 409 | `Registration for this tournament has not opened yet.` |
| Registration closed | 409 | `Registration has closed for this tournament.` |
| Already started | 409 | `This tournament has already started.` |
| Finished | 409 | `This tournament has finished.` |
| Cancelled | 409 | `This tournament was cancelled.` |
| Tournament full | 409 | `That tournament is full.` |
| Check-in not open yet | 409 | `Check-in has not opened yet.` |
| Already playing elsewhere | 409 | `You are already playing a match in Ink Royale. Finish it first.` |
| Not a participant of a match | 404 | `That match does not exist.` |
| Scheduler without the secret | 401 | `Not authorised.` |

There is no longer a "you are already in another tournament" refusal.

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

Per tournament, because a player may be in more than one of them. Computed
server-side because the rules behind it are server rules — a client that
re-derived them would be a second implementation that could disagree, and the
disagreement would look like a button that does nothing.

`phaseEndsAtMs` is the one clock a card should render, and the server picks
which: registration opening while `UPCOMING`, registration closing while
`REGISTRATION`, the published start while in `CHECK_IN`.

---

## 7. Socket events

All under two names — `s:tournament:x` and the flatter `tournament:x` — so a
client written against either vocabulary works.

**Subscription:** `c:tournament:watch` / `c:tournament:unwatch`. Membership is
per *connection* and does not survive a reconnect, so clients re-send on
`connect`. Without that a tab goes quiet after its first dropped connection and
the symptom is indistinguishable from a quiet hour.

Every event carries `tournamentId`, `tournamentDate`, `dailySlot`, `slotNumber`,
`name` and the tournament's `status` — see `tournamentRef` in `notify.ts`. A
client showing three cards needs to know which one changed, and an event that
omitted it would update the wrong card.

| Event | Sent to | Carries |
|---|---|---|
| `tournament:created` | lobby | the identity block, start time, when registration opens |
| `tournament:registration_opened` | lobby | every window on the row, sizes |
| `tournament:registration_updated` | lobby | human/bot/total counts |
| `tournament:checkin_opened` | lobby | check-in window, start time, registered humans |
| `tournament:checkin_closed` | lobby | final counts |
| `tournament:started` | lobby | rounds, players |
| `tournament:bracket_updated` | lobby | match/round |
| `tournament:match_ready` | **the two players only** | room code, entry deadline |
| `tournament:match_started` | lobby | round, match |
| `tournament:match_completed` | lobby | winner, outcome, scores |
| `tournament:round_completed` | lobby | round number |
| `tournament:completed` | lobby | **that tournament's** winner and `completedAtMs` |
| `tournament:cancelled` | lobby | reason |
| `tournament:next_scheduled` | lobby | a future day has been published |
| `tournament:countdown_started` | lobby | fast-start only |
| `tournament:bot_added` / `bot_status_updated` | lobby | bot id, difficulty, state |
| `tournament:player_replaced_by_bot` | **the opponent only** | who dropped, which bot took over |

Bot gameplay reuses the existing events verbatim — `s:draw:begin`,
`s:draw:append`, `s:draw:end`, `s:chat:message`, `s:game:roundStart`,
`s:game:roundEnd`, `s:game:end`. A client cannot tell a bot's stroke from a
person's, which is the point: it goes through the same relay.

---

## 8. Environment

```bash
TOURNAMENT_TIMEZONE=Asia/Kolkata       # the day, and what "20:00" means
TOURNAMENT_MORNING_AT=10:00
TOURNAMENT_AFTERNOON_AT=15:00
TOURNAMENT_EVENING_AT=20:00
TOURNAMENT_PREPARE_DAYS_AHEAD=1        # today and tomorrow

TOURNAMENT_REGISTRATION_LEAD_MINUTES=90   # before the start, registration opens
TOURNAMENT_CHECKIN_LEAD_MINUTES=10        # before the start, it closes
TOURNAMENT_CHECKIN_ENABLED=true           # the daily model needs this on

TOURNAMENT_MIN_PLAYERS=4
TOURNAMENT_MAX_PLAYERS=16              # a ceiling, not a quota
TOURNAMENT_MIN_HUMAN_PLAYERS=1         # makes a bot-only tournament impossible
TOURNAMENT_MAX_BOTS=3
TOURNAMENT_ALLOW_BOTS=true
TOURNAMENT_BOT_DIFFICULTY=NORMAL       # EASY | NORMAL | HARD

TOURNAMENT_BOT_FILL_DELAY_SECONDS=45   # fast-start path only
TOURNAMENT_START_COUNTDOWN_SECONDS=15  # fast-start path only

TOURNAMENT_SCHEDULER_ENABLED=true      # false when an external cron drives it
TOURNAMENT_SCHEDULER_SECRET=           # required in production
```

There is **no** `TOURNAMENT_SLOT_COUNT`. Three is not a quantity here, it is
three named times of day; a deployment wanting a fourth is asking for a
different product rather than a bigger number.

Sizes and bot policy are **copied onto each tournament at creation**, and so is
the whole schedule — so a tournament already taking registrations keeps the
rules *and the start time* it advertised even if the deployment is reconfigured
mid-window. `openRegistration` writes one field, the status, for exactly this
reason.

### Turning check-in off

`TOURNAMENT_CHECKIN_ENABLED=false` restores the back-to-back behaviour:
registration seals on the bot-fill timer or on reaching `minPlayers`, a
fifteen-second countdown runs (`STARTING`), and joining is the confirmation. The
daily schedule still publishes three a day; they simply seal earlier. It also
turns off the check-in push notification, which has nothing to fire on.

---

## 9. Deployment

**Option 1 — in-process loop** (`TOURNAMENT_SCHEDULER_ENABLED=true`). The
realtime process ticks every five seconds. Started from `attachSocketServer`, so
it runs wherever the rooms are — a scheduler in a process with no socket server
would open match rooms nobody could join.

**Option 2 — external cron.** Set `TOURNAMENT_SCHEDULER_ENABLED=false` and:

```bash
curl -X POST https://your-host/api/internal/tournaments/scheduler \
  -H "x-scheduler-secret: $TOURNAMENT_SCHEDULER_SECRET"
```

Both at once is safe. Every tick takes the same distributed lock, so a migration
from one to the other needs no coordination.

**After deploying, sync the indexes.** They are not an optimisation — they are
what enforces the daily rule, the duplicate-registration rule and the
one-match-per-bracket-position rule:

```bash
npm run sync-indexes
```

This is required when upgrading from the rolling version: it drops
`one_live_tournament_per_slot` and builds `one_tournament_per_slot_per_day`.
Rows written by the rolling version have no `tournamentDate` or `dailySlot` and
will not appear in any day listing; they are inert, and the simplest thing to do
with them is delete them.

### The lock

One row, `tournament_scheduler_locks`, taken with a single `findOneAndUpdate`
filtered on the lease being absent or expired. Mongo applies that atomically, so
of two processes trying at the same instant exactly one comes back with a
document. The 90-second lease is what recovers from a process that died
mid-tick; release is best effort, because if it never runs the lease expires
anyway.

---

## 10. What a tick does

1. **Publish** any of today's or tomorrow's three that do not exist yet.
2. **Open registration** on anything `UPCOMING` whose window has arrived — and
   only those. Tomorrow evening's tournament exists tonight and must stay dark.
3. **Advance** every unfinished tournament past whichever deadline has passed;
   write off one whose start came and went without it ever opening.
4. **Decide** the matches whose entry deadline lapsed.
5. **Progress** every running tournament past a finished round.

Step 3 catches per tournament, which is the isolation the product asks for: the
morning tournament failing to seed must not stop the afternoon one opening.

---

## 11. Security

| Rule | How it is enforced |
|---|---|
| Only the backend creates tournaments | No route exists. `createdByType` has one legal value. |
| Never more than three a day | A unique index on `{tournamentDate, dailySlot, isAutomatic}`. |
| Users cannot create tournaments | `auto.service` has no `create`; the planner is imported by no handler. |
| Only the backend creates bot registrations | `botProfileService` is imported by no handler. |
| Clients cannot impersonate a bot | `seatBot` is unreachable from any handler; bots hold no socket. |
| Clients cannot set `playerType` / `isBot` | Never read from a payload; set by `seatBot` alone. |
| Clients cannot set scores or winners | The engine computes both; the bracket copies the engine's standings. |
| A winner cannot be recorded twice | The close is conditional on the status it expects to replace. |
| Guessers cannot reach the answer | `serializeGameState` nulls `word` for non-drawers; the bot guesser's only input type has no field for it. |
| Outsiders cannot enter a match | `room.allowedUserIds`, checked before anything else in `joinRoom`. Refused as 404, so a guessed code confirms nothing. |
| Match codes are not broadcast | Blanked in `toMatchDto` for non-participants. |
| No duplicate registrations | Two partial unique indexes. |
| No two matches at once | Checked at `match.service.enter`. |
| Bots are off every human leaderboard | `endGame` filters `humanStandings` before every durable write. |
| Bots have no voice | Tournament match rooms set `voiceEnabled: false`. |

---

## 12. Testing

```bash
npm run test           # 631 tests, 27 files
```

| File | Covers |
|---|---|
| `tests/dailyTournament.test.ts` | The daily rules, against a real mongod: three a day and never four, concurrent schedulers, restarts, cancellation, name rotation and its consecutive-day guarantee, the schedule arithmetic, timezone day boundaries and DST, the winner belonging to one tournament, and a hundred players across a day. |
| `tests/autoTournament.test.ts` | Registration, check-in, brackets, byes, advancement idempotency, the winner snapshot surviving a rename, joining more than one of a day's tournaments, and the fast-start path under its own configuration. |
| `tests/botFill.test.ts` | Every fill case, including the cancel paths and the ceilings. |
| `tests/botPlayer.test.ts` | Guesser inputs, mask filtering, difficulty, drawing plans, template coverage. |
| `tests/botMatch.test.ts` | The driver: word selection, strokes reaching the board, guesses reaching the engine, timer cleanup. |

On the app side, `test/widget/tournaments_screen_test.dart` pins the screen's
*absences* — no create button, no second play button, no join on a finished
card, no "enter match" without an assigned match — because an absence is
exactly what a refactor puts back and nothing in the type system notices.

### Two bugs the tests found (still worth knowing)

1. **Compound `sparse` indexes do not skip null components.** The registration
   uniqueness indexes were sparse; because every row has a `tournamentId`, every
   row was indexed — so the second human in a tournament collided with the first
   on `{tournamentId, botId: null}`. Fixed with `partialFilterExpression`.

2. **A bot picked a word and then never drew.** The "already running?" check
   matched on seat and round alone, so a finished selection task made the
   drawing look like work already under way. Fixed by giving each task a kind.

---

## 13. Known limitations

- **Capacity is a count, not a claim.** `register` counts the roster and
  compares it to `maxPlayers`; under enough *simultaneous* joins more than
  `maxPlayers` could slip in, and the seeder would then truncate the bracket at
  `maxBracketSize` and leave somebody registered but unseeded. An atomic
  claim on a counter would close it.
- **The bot does not see the drawing.** It compares coarse statistics of the
  board against its own template library.
- **Bot drawings are a fixed library.** Anything outside it draws a neutral
  fallback, unguessable by design.
- **Brackets do not survive a process restart mid-match.** The room's board and
  countdown only ever existed in memory; the match's entry deadline then decides
  it. The bracket itself is durable throughout.
- **Presence is process-local.** The walkover check reads `socketIds` from the
  in-memory registry, so under a multi-instance deployment a player connected to
  another instance could read as absent. A Redis adapter fixes this.
- **One lock for all tournaments.** Fine at three a day.
- **The day listing is read on every tick by every viewer.** Backed by indexes
  and denormalised counts, but not cached — worth a short TTL cache if the
  tournament screen becomes the busiest in the app.

## 14. Possible next steps

- Claim capacity atomically, closing the overshoot above.
- Seed drawing templates from the actual word bank rather than a fixed twenty.
- Per-slot bot difficulty, so the evening tournament can be the hard one.
- Spectating a final — the room already supports spectators, it is only switched
  off for match rooms.
- A results screen for a past day (`/api/tournaments/today?date=` already serves
  it).
- Redis adapter, which turns the presence limitation above into a non-issue.
