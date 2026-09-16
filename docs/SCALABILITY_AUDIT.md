# Scalability Audit — Scribble & Guess

Target: ~100 concurrent users, multiple active rooms, stable under real play.

Baseline taken before any change: `tsc --noEmit` clean, `vitest run` → **411 tests
passing across 19 files**. Backend ≈27.6k LOC TypeScript, Flutter client ≈47.4k
LOC Dart, Next.js web client ≈3.9k LOC TSX.

---

## Summary

The backend is in materially better shape than a greenfield audit would assume.
Most of the brief's checklist is **already implemented**, and implemented well.
The work that remains is concentrated in four places:

1. **The Flutter canvas** — the one genuine "will not hold up" finding.
2. **Two O(n) scans on the drawing hot path** (one per side of the wire).
3. **Observability** — there is almost none beyond a health endpoint.
4. **Load testing** — none exists, so no scale claim is currently evidence-backed.

Everything else below is either already correct, or a bounded cleanup.

---

## Part A — Already correct (verified, no work required)

These are listed because the brief asks for them and re-implementing them would
be churn. Each was read and confirmed.

### Crash prevention (§13)
- `unhandledRejection` and `uncaughtException` handlers on **both** entrypoints
  (`server.ts`, `socket-server.ts`); uncaught exception triggers graceful shutdown.
- Graceful shutdown: `io.close()` → `server.close()` → `disconnectFromDatabase()`,
  with a 10s forced-exit backstop.
- `withErrorHandling` wraps every REST route; internal errors are logged with
  stack and returned as a bare `INTERNAL_ERROR` — no schema or stack leakage.
- Socket `on()` wrapper guarantees an ack is called **exactly once**, converting
  throws into `{ok:false, error}`. This is what stops a handler throw becoming an
  8-second client hang.
- `roomService.persist()` swallows and logs write failures rather than taking
  down a live turn — durability is sacrificed, never correctness.

### MongoDB (§4)
- Connection cached on `globalThis`, re-validated against the driver's
  `readyState` on every call (handles frozen/thawed serverless sockets).
- `bufferCommands: false`, `serverSelectionTimeoutMS: 8000`, `maxPoolSize: 20`.
- **Indexes are comprehensive.** Every index named in the brief exists, plus:
  - `users`: `{totalScore:-1, gamesWon:-1, _id:1}` — the `_id` tie-break is *in*
    the index, which is what makes leaderboard paging stable between requests.
  - `users`: `{localityKey:1, totalScore:-1, gamesWon:-1, _id:1}`.
  - `rooms`: partial-unique `roomCode` filtered on `closedAt:null` (codes recycle).
  - `rooms`: `{closedAt:1, 'settings.isPrivate':1, status:1, createdAt:1}`.
  - TTL indexes (`expireAfterSeconds: 0`) on `notifications.expiresAt` and
    `xpevents.expiresAt`.
- Pagination + projection + `.lean()` used throughout. Leaderboard skip is
  hard-capped by `PAGE_LIMITS.maxPage` and **refuses** past the cap rather than
  silently clamping.
- No drawing data is written to Mongo per event — only one compacted snapshot
  per turn, bounded by `REPLAY_LIMITS`.

### Socket.IO (§2)
- **All** broadcasting is room-scoped: `roomChannel`, `userChannel`,
  `voiceChannel`. No handler holds a socket list. (One exception — see B-4.)
- Every payload is Zod-validated or explicitly sanitised.
- `maxHttpBufferSize: 1e6`.
- 25 named token-bucket rate limits, applied to both HTTP and socket paths.
- Drawing is already stroke-based and batched, with coordinates normalised to
  0..1 and clamped server-side; `maxPointsPerBatch: 200`,
  `maxPointsPerStroke: 2000`, `maxStrokesPerBoard: 4000`.
- Disconnect handling is careful: seats survive a drop (`reconnectGraceMs: 45s`),
  multi-device presence is **counted** not flagged, and voice teardown is guarded
  on socket id so closing one device does not hang up the other.
- Reconnect restores room state fully (`restoreSeat` → registry, then Mongo
  `hydrate`), replaying room state, board snapshot and voice state.

### Concurrency (§5)
- Quick Play has a per-user in-flight gate (`inFlight` Set) that prevents the
  double-tap duplicate-room case.
- The capacity check → seat sequence in `roomService.joinRoom` is **synchronous
  with no interleaved `await`**, so on a single-threaded event loop it is
  genuinely atomic. Rooms cannot overfill via the socket path.
- Quick Play walks ranked candidates and retries on `ROOM_FULL` /
  `GAME_ALREADY_STARTED` / `ROOM_NOT_FOUND` rather than failing the request.
- Rejoin bypasses full/started checks deliberately — a dropped connection never
  costs a seat.

### Voice (§7)
- WebRTC mesh; Socket.IO carries signalling only. No audio touches Node or Mongo.
- STUN/TURN delivered at runtime via `s:voice:state`, not compiled into clients.
- Drawer is excluded from the voice channel entirely (`emitToVoice` is a separate
  fan-out from `emitToRoom`), so the drawer can neither speak nor hear.
- `voiceSignal` bucket sized for mesh setup (burst 200) rather than per-connection.

### Logging (§11, partial)
- Structured single-line JSON in production.
- Recursive `redact()` drops `word`, `answer`, `token`, `password`, `authorization`,
  `cookie`, etc. — the live round's answer is treated as a secret, which is right.
- Stacks suppressed in production output.
- Env vars validated at boot by Zod; boot fails on a missing `JWT_SECRET`.

---

## Part B — Findings

Ordered by expected impact at 100 concurrent users.

### B-1 — Flutter canvas repaints the entire board on every frame · **P0**
`lib/widgets/drawing_canvas.dart`

Two compounding problems:

- `_BoardPainter.paint()` iterates **every committed stroke** and rebuilds its
  `Path` from scratch — denormalising every point — on each paint.
- `DrawingBoard` is immutable: `addStroke` / `replaceStroke` return a **new
  `List`** each time. So `shouldRepaint`'s `!identical(oldDelegate.strokes, strokes)`
  is **always true**. Every inbound `s:draw:append` (~17/sec per drawer) forces a
  full-board repaint.
- Separately, `game_screen.dart:118` calls `setState(() => _pending = stroke)` on
  **every `onPanUpdate`** (~60/sec while drawing), rebuilding the whole 729-line
  game screen — HUD, chat panel, player list, toolbar — not just the canvas.

At the brief's 1000/5000-stroke test points this cannot hold 60fps on a low-end
Android device. This is the single largest client-side risk.

**Fix:** cache committed strokes into a `ui.Picture`, invalidated only when the
committed stroke list actually changes; paint the pending stroke on top. Move
`_pending` to a `ValueNotifier` + `RepaintBoundary` so a drag rebuilds the canvas
only, never the screen.

### B-2 — O(n) stroke lookup on the drawing hot path (both sides) · **P1**
`src/services/drawing.service.ts:append()` — `room.board.strokes.find(...)`, a
linear scan over up to 4000 strokes, executed ~17×/sec per active drawer.
`lib/models/drawing_board.dart:replaceStroke()` — `indexWhere`, identical shape.

With 10 simultaneous rooms this is ~170 scans/sec against a growing array on the
server, and the same per client.

**Fix:** maintain an id→stroke index alongside the array (server) and an
id→position map (client). Both are cheap because strokes are append-mostly.

### B-3 — No observability · **P1**
There is a health endpoint and structured logging, and nothing else. Missing
entirely: CPU/RAM, **event-loop lag** (the single most important Node signal),
active socket count, active room count, API response time percentiles, socket
event latency, error counts, reconnect counts, Mongo slow-query monitoring,
request IDs.

Without this, a load test produces numbers with nothing to attribute them to.

**Fix:** a metrics collector + `/api/metrics`, mongoose command monitoring for
slow queries, per-request ids threaded through `withErrorHandling`.

### B-4 — Global time-sync broadcast · **P2**
`src/socket/socket.server.ts` — `io.emit(SERVER_TIME_SYNC, …)` every 20s reaches
**every connected socket**, including players sitting in menus who have no
countdown to render. This is the one place the "never broadcast to unrelated
rooms" rule is not held.

At 100 users it is 100 frames per 20s — not dangerous, but it is unbounded in the
wrong dimension and it is the only global fan-out in the codebase.

**Fix:** emit only into room channels that have a live timed phase.

### B-5 — `hydrate()` check-then-act race · **P2**
`src/services/room.service.ts:hydrate()` reads `this.get(roomId)` (miss), then
`await roomRepository.findById(...)`, then `registry.byId.set(...)`. Two
concurrent reconnects to the same room after a restart both miss, both build a
`RuntimeRoom`, and the second `set` **overwrites the first — discarding any
player seated on it**.

Narrow window (only post-restart / cold room), real consequence.

**Fix:** memoise the in-flight hydrate promise per room id.

### B-6 — HTTP rate-limit bucket eviction never evicts · **P2**
`src/middleware/rateLimit.middleware.ts`

```ts
if (candidate.tokens >= RATE_LIMITS.action.burst) httpBuckets.delete(candidateKey);
```

Every bucket is compared against `action.burst` (20) regardless of **its own**
rule. A `guess` bucket (burst 8), `chat` (6), `guestLogin` (5) or `joinRoom` (10)
can never reach 20 tokens, so it is never evicted. If the map fills with those,
the guard scans all 10,000 entries, deletes nothing, and **re-runs the full scan
on every subsequent request** — an unbounded map plus a growing per-request cost.

**Fix:** compare each bucket against its own rule's burst; track the rule name
with the bucket.

### B-7 — `broadcastState` always sends full state · **P2**
Every ready-toggle, join, leave, settings change and disconnect emits the
complete room snapshot *and* a per-viewer full game state. A ready toggle in a
12-player room produces 1 room broadcast + 12 individual game-state emits.

Correct, just wasteful. The brief explicitly asks for "send only changed state
where possible".

### B-8 — `emitPerViewer` fetches the socket list per broadcast · **P3**
`await server.in(roomChannel(roomId)).fetchSockets()` allocates wrapped socket
objects on every state broadcast. Fine at this scale; noted because it is the
thing that stops being fine first if room count grows.

### B-9 — Repeated `blockRepository.relatedIds` query · **P3**
Hit once per Quick Play **and** once per public-room listing, per user. At 100
users pull-to-refreshing a room browser this is the most frequent avoidable
query in the app. Block lists change rarely.

**Fix:** short-TTL per-user cache with invalidation on block/unblock.

### B-10 — No TTL index on `room_invitations` · **P3**
There is an application sweeper (`invitationSweepIntervalMs`) and the accept path
checks `expiresAt` directly, so correctness is fine. But the brief asks for TTL
cleanup and the collection has no `expireAfterSeconds` index — rows accumulate
until the sweeper reaches them.

### B-11 — No load testing · **P0 (process)**
No k6/Artillery setup exists. No scale claim in this repo is currently backed by
measurement.

### B-12 — Next.js web client · **P3**
`src/web/GameProvider.tsx` is a single 1050-line context holding all game state,
so any state change re-renders every consumer. No error boundaries, no loading
skeletons, no request cancellation. Low priority — the Flutter app is the primary
client and the web client is a thin companion — but it is in the brief.

---

## Part C — B-13, found by the load test rather than by reading

The audit above was written from the code. Running the suite found something
reading it had not, and it was the most serious defect of the lot.

### B-13 — simultaneous Quick Play opens a room per player · **P0**
`src/services/matchmaking.service.ts`

Eighty-eight virtual players tapping Quick Play in the same tick produced
**76 rooms**. Eleven would have held them all.

The mechanism is a check-then-act across an `await`. `run()` reads the block
list before it ranks candidates, and that read yields the event loop. All
eighty-eight callers reach the yield before *any* of them has created a room,
so when they resume they each rank a registry that is still empty, find
nothing, and go on to create. The rooms they open are invisible to one another
because every decision was made before any of them existed.

This is not cosmetic. A match needs `MIN_PLAYERS_TO_START`, so 76 rooms of one
player is 76 people who cannot start a game — the exact acceptance criterion
"Quick Play does not create unnecessary duplicate rooms", failing in the case
it was written for. The per-user in-flight gate does not help: it guards one
player double-tapping, not different players racing.

**Fix:** serialise the match-or-create decision. Joining an existing room stays
off the queue entirely — `joinRoom`'s capacity-check-then-seat has no `await`
between the two and is already atomic — so only the create path queues, and it
re-ranks under the queue so a caller sees rooms opened by the callers ahead of
it. Measured after: **11 rooms for 88 players**, the theoretical minimum.

---

## Outcomes

| Finding | Status | Evidence |
|---|---|---|
| B-1 Flutter full-board repaint | **Fixed** | Incremental `ui.Picture` cache + `ValueNotifier` for the pending stroke. 10 new widget tests at 1000/5000 strokes. |
| B-2 O(n) stroke lookup | **Fixed** | Server: id index on `RuntimeBoard`. Client: last-stroke fast path in `replaceStroke`. |
| B-3 No observability | **Fixed** | `src/monitoring/`, `/api/metrics`, `/metrics`, Mongo command monitoring, request ids. |
| B-4 Global time-sync broadcast | **Fixed** | Scoped to rooms in a timed phase. |
| B-5 `hydrate()` race | **Fixed** | In-flight promise memoisation. 2 regression tests. |
| B-6 Rate-limit eviction | **Fixed** | Each bucket measured against its own rule. 4 regression tests. |
| B-9 Repeated block query | **Fixed** | 30s `TtlCache`, invalidated on block/unblock. |
| B-10 Invitation TTL | **Fixed** | `expireAfterSeconds` index, one hour past `expiresAt`. |
| B-11 No load testing | **Fixed** | `loadtest/`, 12 scenarios covering the brief's 15 cases. |
| B-13 Quick Play room storm | **Fixed** | Serialised create decision. Regression test verified to fail without it. |
| B-7 Full-state broadcasts | **Open** | Measured cost is low at this scale — see the load report. |
| B-8 `fetchSockets` per broadcast | **Open** | Not a constraint at 100 users. |
| B-12 Next.js web client | **Open** | Secondary client; the Flutter app is primary. |

### Also fixed, prompted by the measurements

- **Mongo pool 20 → 50.** 247 of 3,500 commands exceeded 200ms under 100
  concurrent users, and the slow ones were ordinary indexed reads — they were
  queueing, not running slowly.
- **World leaderboard caching.** It was the slowest endpoint in the app at
  p95 2148ms; a hundred callers were running a hundred identical queries.
  Cached for 10s, invalidated on any score write, and bypassed entirely for a
  viewer with a block list, whose board genuinely differs.
- **A bug in the new metrics code**, found by the first run reporting an empty
  `gauges` block on a process holding a hundred sockets: the gauge registry was
  module-local, so Next's bundle and the socket server's had different copies.

### Verification

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `vitest run` | **427 passing** (411 baseline + 16 new) |
| `next build` | succeeds |
| `flutter analyze` | no issues |
| `flutter test` | **357 passing** (347 baseline + 10 new) |
| Load suite, 100 users | **every correctness check passes**, zero crashes |

See [LOAD_TEST_RESULTS.md](./LOAD_TEST_RESULTS.md) for the measured figures.
