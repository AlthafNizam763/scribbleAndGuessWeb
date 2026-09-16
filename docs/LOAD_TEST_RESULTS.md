# Load Test Results — Scribble & Guess

Run at 2026-09-16T10:21:15.474Z, finished 2026-09-16T10:21:47.994Z.

| | |
|---|---|
| Virtual users | 100 |
| API | `http://127.0.0.1:3210` |
| Realtime | `http://127.0.0.1:3210` |
| Duration | 33s |
| Correctness checks | **all passed** |

## Scenarios

### 100 concurrent API sign-ins and socket connections

Brief section 12, case 1,2. Took 2374ms.

| Check | Result | Detail |
|---|---|---|
| every user authenticated | PASS | 100/100 |
| every authenticated user connected | PASS | 100/100 |

| Figure | Value |
|---|---|
| authenticated | 100 |
| socketsConnected | 100 |
| restErrors | 0 |

### simultaneous Quick Play taps

Brief section 12, case 3,5,13. Took 1559ms.

| Check | Result | Detail |
|---|---|---|
| every Quick Play was answered | PASS | 88/88 |
| no room exceeded its eight seats | PASS | none |
| matchmaking converged rather than opening a room per player | PASS | 11 rooms for 88 players |

| Figure | Value |
|---|---|
| roomsOpened | 11 |
| theoreticalMinimum | 11 |
| roomsCreatedByQuickPlay | 11 |
| quickPlayErrors | 0 |

### 100 users browsing and joining public rooms

Brief section 12, case 4. Took 683ms.

| Check | Result | Detail |
|---|---|---|
| the public list answered every caller | PASS | 100/100 |

| Figure | Value |
|---|---|
| answered | 100 |
| p95Ms | 650.13 |
| p99Ms | 668.95 |

### duplicate and concurrent join requests

Brief section 12, case 14. Took 834ms.

| Check | Result | Detail |
|---|---|---|
| no player is seated twice | PASS | 7 seats, 7 distinct |
| the room is not over its seat limit | PASS | 7/12 |

| Figure | Value |
|---|---|
| seats | 7 |
| distinct | 7 |

### starting a real match in every room

Brief section 12, case 5. Took 9482ms.

| Check | Result | Detail |
|---|---|---|
| every eligible room started a match | PASS | 11/11 |
| every started match reached the drawing phase | PASS | 11/11 |

| Figure | Value |
|---|---|
| roomsEligible | 11 |
| matchesStarted | 11 |
| inDrawingPhase | 11 |

### simultaneous drawing in every active room

Brief section 12, case 6. Took 5586ms.

| Check | Result | Detail |
|---|---|---|
| stroke batches reached the other players in the room | PASS | 100% delivered |
| stroke relay stayed under 250ms at p95 | PASS | p95 13ms, p99 25ms |
| no player was disconnected while drawing | PASS |  |

| Figure | Value |
|---|---|
| rooms | 11 |
| batchesSent | 660 |
| arrivals | 4620 |
| deliveryRatePercent | 100 |
| relayP95Ms | 13 |
| relayP99Ms | 25 |

### chat messages from every seated player

Brief section 12, case 7. Took 1758ms.

| Check | Result | Detail |
|---|---|---|
| normal chat within the burst was delivered | PASS | 0 refusals |
| chat spam was rate limited | PASS | 170/200 refused |

| Figure | Value |
|---|---|
| spamRefused | 170 |
| spamAttempted | 200 |

### 100 concurrent leaderboard reads

Brief section 12, case 8. Took 1061ms.

| Check | Result | Detail |
|---|---|---|
| every leaderboard read was answered | PASS | 100/100 |
| every page respected its limit | PASS | 100/100 |
| an absurd page number is refused rather than served | PASS |  |

| Figure | Value |
|---|---|
| p95Ms | 1008.28 |
| p99Ms | 1018.2 |

### concurrent friend requests

Brief section 12, case 9. Took 2712ms.

| Check | Result | Detail |
|---|---|---|
| friend requests were handled without server errors | PASS | 0 refusals, all client-level |
| requests could be accepted | PASS | 40 friendships formed |

| Figure | Value |
|---|---|
| attempted | 40 |
| refused | 0 |
| friendships | 40 |
| p95Ms | 902.06 |

### concurrent room invitations

Brief section 12, case 10. Took 819ms.

| Check | Result | Detail |
|---|---|---|
| invitations were handled without server errors | PASS |  |

| Figure | Value |
|---|---|
| sent | 20 |
| delivered | 0 |
| refused | 20 |

### voice signalling under load

Brief section 12, case 12. Took 1565ms.

| Check | Result | Detail |
|---|---|---|
| voice signalling relayed candidates between peers | PASS | 2310 frames |
| voice joins were handled without server errors | PASS |  |

| Figure | Value |
|---|---|
| admitted | 77 |
| iceRelayed | 2310 |
| refusals | 1 |

### many players racing for one last seat

Brief section 12, case 13. Took 834ms.

| Check | Result | Detail |
|---|---|---|
| exactly one racer took the last seat | PASS | 1 admitted |
| the room never exceeded two seats | PASS | 2 seats |
| the losers were told the room was full | PASS | 9 refused |

| Figure | Value |
|---|---|
| racers | 10 |
| admitted | 1 |
| seats | 2 |

### mass disconnect and reconnect

Brief section 12, case 11. Took 3140ms.

| Check | Result | Detail |
|---|---|---|
| every dropped player reconnected | PASS | 90/90 |
| every reconnect restored the correct room | PASS | 90/90 |

| Figure | Value |
|---|---|
| dropped | 90 |
| restored | 90 |
| reconnectP95Ms | 1564.4 |

## Client-observed latency

Measured at the virtual user, so these include connection setup, queueing
and the network — not just server processing time.

| Operation | Count | Errors | Error % | Mean | p50 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `draw.relayLatency` | 4620 | 0 | 0.00% | 5.04ms | 4ms | 13ms | 25ms | 37ms |
| `rest.auth.guest` | 100 | 0 | 0.00% | 1188.2ms | 1287.54ms | 1433.1ms | 1447.83ms | 1447.83ms |
| `rest.friends.accept` | 40 | 0 | 0.00% | 530.19ms | 541.08ms | 557.07ms | 558.01ms | 558.01ms |
| `rest.friends.incoming` | 40 | 0 | 0.00% | 345.83ms | 317.64ms | 451.32ms | 452.13ms | 452.13ms |
| `rest.friends.request` | 40 | 0 | 0.00% | 858.36ms | 857.18ms | 902.06ms | 980.63ms | 980.63ms |
| `rest.leaderboard.beyondCap` | 1 | 1 | 50.00% | 14.51ms | 14.51ms | 14.51ms | 14.51ms | 14.51ms |
| `rest.leaderboard.world` | 100 | 0 | 0.00% | 879.46ms | 859.13ms | 1008.28ms | 1018.2ms | 1018.2ms |
| `rest.rooms.public` | 100 | 0 | 0.00% | 587.84ms | 594.07ms | 650.13ms | 668.95ms | 668.95ms |
| `socket.chat` | 534 | 0 | 0.00% | 119.41ms | 105.32ms | 198.8ms | 741.09ms | 789.67ms |
| `socket.chat.spam` | 200 | 170 | 46.00% | 39.75ms | 39.36ms | 59.74ms | 61.8ms | 61.84ms |
| `socket.connect` | 190 | 0 | 0.00% | 943.64ms | 591.19ms | 1564.4ms | 1808.3ms | 1811.22ms |
| `socket.create.duplicate` | 1 | 0 | 0.00% | 9.45ms | 9.45ms | 9.45ms | 9.45ms | 9.45ms |
| `socket.create.race` | 1 | 0 | 0.00% | 50.05ms | 50.05ms | 50.05ms | 50.05ms | 50.05ms |
| `socket.game.selectWord` | 11 | 0 | 0.00% | 7.91ms | 7.17ms | 11.52ms | 11.52ms | 11.52ms |
| `socket.game.start` | 11 | 0 | 0.00% | 120.8ms | 105.41ms | 210.2ms | 210.2ms | 210.2ms |
| `socket.hello` | 190 | 0 | 0.00% | 213.94ms | 205.3ms | 434.45ms | 465.79ms | 473ms |
| `socket.invite` | 20 | 20 | 50.00% | 52.23ms | 52.34ms | 55.19ms | 55.19ms | 55.19ms |
| `socket.join.duplicate` | 12 | 0 | 0.00% | 49.9ms | 55.3ms | 69.41ms | 69.41ms | 69.41ms |
| `socket.join.race` | 10 | 9 | 47.00% | 26.34ms | 27.55ms | 31.82ms | 31.82ms | 31.82ms |
| `socket.quickPlay` | 88 | 0 | 0.00% | 466.94ms | 465.84ms | 752.52ms | 785.62ms | 785.62ms |
| `socket.ready` | 88 | 0 | 0.00% | 333.48ms | 343.85ms | 406.38ms | 458.83ms | 458.83ms |
| `socket.voice.join` | 78 | 1 | 1.00% | 21.02ms | 20.98ms | 26.72ms | 26.81ms | 26.81ms |

## Server resources

| Metric | Before | After |
|---|---:|---:|
| CPU (% of one core) | 80.425 | 38.645 |
| RSS (MB) | 167.61 | 281.83 |
| Heap used (MB) | 83.89 | 108.54 |
| Event-loop delay p99 (ms) | 589.824 | 175.112 |
| Event-loop delay max (ms) | 589.824 | 891.814 |
| Active handles | 23 | 157 |

### Realtime gauges at the end of the run

| Gauge | Value |
|---|---:|
| socketsConnected | 100 |
| rooms | 13 |
| roomsInGame | 11 |
| seatsOccupied | 91 |
| playersConnected | 91 |
| voiceParticipants | 0 |
| strokesHeld | 11 |

### Server counters (delta over the run)

| Counter | Delta |
|---|---:|
| http.errors.client | 1 |
| http.requests | 422 |
| mongo.commands | 3575 |
| mongo.commands.slow | 341 |
| socket.connections | 190 |
| socket.disconnect.client namespace disconnect | 90 |
| socket.disconnections | 90 |
| socket.events | 4236 |
| socket.events.failed | 200 |
| socket.reconnects.restored | 90 |

### MongoDB command latency

| Command | Count | p95 | p99 | Max |
|---|---:|---:|---:|---:|
| create | 16 | 192ms | 192ms | 192ms |
| createIndexes | 46 | 117ms | 152ms | 152ms |
| insert | 947 | 516ms | 783ms | 793ms |
| find | 1536 | 332ms | 375ms | 626ms |
| update | 872 | 318ms | 346ms | 349ms |
| aggregate | 220 | 171ms | 176ms | 177ms |

Slow commands (over 200ms): **341**

### Socket handler latency (server-side)

| Event | Count | p95 | p99 |
|---|---:|---:|---:|
| `c:voice:ice` | 2310 | 1.859ms | 3.292ms |
| `c:chat:send` | 734 | 2.419ms | 4.123ms |
| `c:draw:append` | 660 | 1.05ms | 1.694ms |
| `c:hello` | 190 | 148.787ms | 149.373ms |
| `c:room:quickPlay` | 88 | 699.497ms | 749.403ms |
| `c:room:ready` | 88 | 320.636ms | 333.359ms |
| `c:voice:join` | 78 | 1.205ms | 1.795ms |
| `c:room:join` | 22 | 53.588ms | 54.093ms |
| `c:room:invite` | 20 | 1.024ms | 1.024ms |
| `c:game:start` | 11 | 66.201ms | 66.201ms |
| `c:game:selectWord` | 11 | 9.033ms | 9.033ms |
| `c:draw:begin` | 11 | 5.444ms | 5.444ms |
| `c:draw:end` | 11 | 0.558ms | 0.558ms |
| `c:room:create` | 2 | 49.134ms | 49.134ms |

## Failures observed

Refusals the server deliberately sent — room full, rate limited — appear
here too. A scenario that expects them says so in its checks above.

| Operation | Reason | Count |
|---|---|---:|
| `socket.chat.spam` | Error: invalidAction: Slow down a moment. | 170 |
| `socket.invite` | Error: roomFull: Room is full. | 20 |
| `socket.join.race` | Error: roomFull: That room is full. | 9 |
| `rest.leaderboard.beyondCap` | Error: HTTP 422 VALIDATION_ERROR Pages stop at 400. Narrow the list instead. | 1 |
| `socket.voice.join` | Error: invalidAction: Voice chat is not open right now. | 1 |

## Crash count

None. The server's uptime increased monotonically across the run, so the process never restarted.
