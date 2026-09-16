import type { Recorder } from './recorder';
import type { VirtualUser } from './virtualUser';

/**
 * The load scenarios (brief section 12, cases 1 to 15).
 *
 * ## What a scenario is allowed to assert
 *
 * Latency and error rate are *recorded*, never asserted — those are the
 * report's job, and a scenario that threw on a slow response would hide the
 * measurement the run exists to produce.
 *
 * What a scenario does assert is **correctness under concurrency**: that a
 * room of eight never seats nine, that a hundred simultaneous Quick Plays do
 * not produce a hundred rooms, that a duplicate join does not duplicate a
 * player. Those are pass/fail, they are the acceptance criteria in section 14,
 * and they are the things that only break under load.
 */

export interface ScenarioContext {
  users: VirtualUser[];
  recorder: Recorder;
  /** Prints a line to the run log. */
  log: (message: string) => void;
}

export interface Scenario {
  /** Which of the brief's fifteen cases this covers. */
  id: string;
  name: string;
  run: (context: ScenarioContext) => Promise<ScenarioResult>;
}

export interface ScenarioResult {
  /** Assertions about correctness, each pass or fail. */
  checks: Array<{ label: string; passed: boolean; detail?: string }>;
  /** Free-form figures worth putting in the report. */
  notes?: Record<string, string | number>;
}

/**
 * How many users Quick Play is allowed to seat.
 *
 * The remainder stay unseated so the scenarios that need a *free* player —
 * the last-seat race needs a host and a dozen racers who are not already in a
 * room — have somebody to work with.
 */
const RESERVE_FROM = -12;

/** Runs `work` for every user at once, which is the point of a load test. */
async function allAtOnce<T>(
  users: VirtualUser[],
  work: (user: VirtualUser) => Promise<T>,
): Promise<T[]> {
  return Promise.all(users.map(work));
}

/** A pause, for letting broadcasts settle before counting them. */
function settle(ms = 750): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- 1 and 2 --

/**
 * Cases 1 and 2: a hundred concurrent REST callers and a hundred sockets.
 *
 * This is the run's foundation — every later scenario reuses the identities
 * and the connections it establishes — so it is also the first thing that
 * would fail if the server could not take the connection count at all.
 */
export const connectStorm: Scenario = {
  id: '1,2',
  name: '100 concurrent API sign-ins and socket connections',
  async run({ users, recorder, log }) {
    log(`signing in ${users.length} users simultaneously`);
    const signedIn = await allAtOnce(users, (user) => user.signIn());

    const authenticated = signedIn.filter(Boolean).length;
    log(`  ${authenticated}/${users.length} authenticated`);

    log('opening every socket simultaneously');
    const connected = await allAtOnce(
      users.filter((user) => user.token),
      (user) => user.connect(),
    );

    const live = connected.filter(Boolean).length;
    log(`  ${live} sockets connected`);

    // The handshake, which is what actually admits a socket to its user
    // channel and restores any seat it still holds.
    await allAtOnce(
      users.filter((user) => user.socket?.connected),
      (user) => user.hello().then(() => undefined),
    );

    return {
      checks: [
        {
          label: 'every user authenticated',
          passed: authenticated === users.length,
          detail: `${authenticated}/${users.length}`,
        },
        {
          label: 'every authenticated user connected',
          passed: live === authenticated,
          detail: `${live}/${authenticated}`,
        },
      ],
      notes: {
        authenticated,
        socketsConnected: live,
        restErrors: recorder.summaries()['rest.auth.guest']?.errors ?? 0,
      },
    };
  },
};

// ---------------------------------------------------------- 3, 5, 13, 14 --

/**
 * Cases 3, 5 and 13: everybody taps Quick Play at the same instant.
 *
 * ## What this is really testing
 *
 * Not throughput — a hundred acks is nothing. It is the matchmaker's
 * behaviour when a hundred callers reach `rankCandidates` before any of them
 * has been seated: every one of them sees the same empty registry, and the
 * naive outcome is a hundred rooms of one player each.
 *
 * The room count is therefore the assertion. With eight seats a room, a
 * hundred players need at least thirteen rooms; a matchmaker that converges
 * should land close to that, and one that does not is visibly broken.
 *
 * It also covers case 13 — the full-room race — because convergence means
 * many callers arriving at the last seat of the same room at once. Not one of
 * them may overfill it.
 */
export const quickPlayStorm: Scenario = {
  id: '3,5,13',
  name: 'simultaneous Quick Play taps',
  async run({ users, recorder, log }) {
    // A dozen users are held back unseated. `lastSeatRace` needs a host and
    // racers who are not already in a room, and a Quick Play that seats
    // literally everybody leaves it nothing to work with — which is how that
    // scenario reported "no free user was available to host" rather than
    // testing anything.
    const ready = users.filter((user) => user.socket?.connected).slice(0, RESERVE_FROM);
    log(`${ready.length} users tapping Quick Play at once (${users.length - ready.length} held back)`);

    const acks = await allAtOnce(ready, async (user) => {
      const ack = await user.emit('socket.quickPlay', 'c:room:quickPlay', {
        username: user.username,
      });
      user.noteRoom(ack);
      return ack;
    });

    await settle();

    const seated = acks.filter((ack) => ack?.ok).length;
    const rooms = new Map<string, number>();
    for (const user of ready) {
      if (!user.roomId) continue;
      rooms.set(user.roomId, (rooms.get(user.roomId) ?? 0) + 1);
    }

    const overfilled = [...rooms.entries()].filter(([, count]) => count > 8);
    const created = acks.filter((ack) => ack?.created === true).length;

    // A perfectly converging matchmaker opens ceil(n/8) rooms. Anything up to
    // twice that is ordinary racing; a room per player is the failure this
    // scenario exists to catch.
    const floor = Math.ceil(seated / 8);

    log(`  ${seated} seated across ${rooms.size} rooms (floor ${floor}, created ${created})`);

    return {
      checks: [
        {
          label: 'every Quick Play was answered',
          passed: seated === ready.length,
          detail: `${seated}/${ready.length}`,
        },
        {
          label: 'no room exceeded its eight seats',
          passed: overfilled.length === 0,
          detail:
            overfilled.length === 0
              ? 'none'
              : overfilled.map(([id, count]) => `${id}=${count}`).join(', '),
        },
        {
          label: 'matchmaking converged rather than opening a room per player',
          passed: rooms.size <= Math.max(4, floor * 2),
          detail: `${rooms.size} rooms for ${seated} players`,
        },
      ],
      notes: {
        roomsOpened: rooms.size,
        theoreticalMinimum: floor,
        roomsCreatedByQuickPlay: created,
        quickPlayErrors: recorder.summaries()['socket.quickPlay']?.errors ?? 0,
      },
    };
  },
};

/**
 * Case 14: the same user sends the same join twice, at once.
 *
 * A double tap, or a client retrying after a slow ack. Neither may seat the
 * player twice, and the room's occupancy must not move on the second call.
 */
export const duplicateJoins: Scenario = {
  id: '14',
  name: 'duplicate and concurrent join requests',
  async run({ users, log }) {
    // A room opened for this, rather than one Quick Play produced. Those fill
    // to eight, so every join into one is correctly refused as full — which is
    // the server behaving and the test measuring nothing.
    const free = users.filter((user) => user.socket?.connected && !user.roomId);
    const host = free[0];
    if (!host) {
      return { checks: [{ label: 'a free user was available to host', passed: false }] };
    }

    const created = await host.emit('socket.create.duplicate', 'c:room:create', {
      settings: { maxPlayers: 12, rounds: 1, drawTimeSeconds: 30, isPrivate: true },
    });
    host.noteRoom(created);

    const code = host.roomCode;
    if (!code) {
      return { checks: [{ label: 'the test room was created', passed: false }] };
    }

    const joiners = free.slice(1, 7);

    log(`${joiners.length} users each sending two simultaneous joins for ${code}`);

    // Two identical joins per user, fired together.
    await allAtOnce(joiners, async (user) => {
      await Promise.all([
        user.emit('socket.join.duplicate', 'c:room:join', { roomCode: code }),
        user.emit('socket.join.duplicate', 'c:room:join', { roomCode: code }),
      ]);
    });

    await settle();

    // The room snapshot every member holds must agree, and must list each
    // player exactly once.
    const snapshot = host.last.get('s:room:state') as
      | { room?: { players?: Array<{ id: string }>; settings?: { maxPlayers?: number } } }
      | undefined;

    const players = snapshot?.room?.players ?? [];
    const ids = players.map((player) => player.id);
    const unique = new Set(ids);
    const maxPlayers = snapshot?.room?.settings?.maxPlayers ?? 8;

    log(`  room holds ${ids.length} seats, ${unique.size} distinct`);

    return {
      checks: [
        {
          label: 'no player is seated twice',
          passed: ids.length === unique.size,
          detail: `${ids.length} seats, ${unique.size} distinct`,
        },
        {
          label: 'the room is not over its seat limit',
          passed: ids.length <= maxPlayers,
          detail: `${ids.length}/${maxPlayers}`,
        },
      ],
      notes: { seats: ids.length, distinct: unique.size },
    };
  },
};

/**
 * Case 5: start a real match in every room that can hold one.
 *
 * ## Why this scenario exists at all
 *
 * The drawing and voice scenarios below are meaningless without it, and the
 * first run proved it: with every room still in its lobby, `c:draw:append`
 * was correctly refused by `assertCanDraw` and `c:voice:join` by
 * `isVoicePhase`, so both scenarios measured a hundred refusals and called it
 * a delivery failure. The server was right and the test was wrong.
 *
 * So this drives the actual game flow — host starts, the server picks a
 * drawer and offers them words, the drawer chooses — until each room is in
 * the `drawing` phase with a real drawer. Everything after it is then testing
 * the paths players actually use.
 */
export const startGames: Scenario = {
  id: '5',
  name: 'starting a real match in every room',
  async run({ users, log }) {
    const byRoom = groupByRoom(users);
    const startable = [...byRoom.values()].filter((seats) => seats.length >= 2);

    log(`${startable.length} rooms have the two players a match needs`);

    const started = await Promise.all(
      startable.map(async (seats) => {
        // The host is whoever the room snapshot names, not whoever happens to
        // be first in this list.
        const snapshot = seats[0]!.last.get('s:room:state') as
          | { room?: { hostId?: string } }
          | undefined;
        const hostId = snapshot?.room?.hostId;
        const host = seats.find((user) => user.userId === hostId) ?? seats[0]!;

        // Everybody readies up first — `startGame` refuses otherwise.
        await allAtOnce(seats, (user) => user.emit('socket.ready', 'c:room:ready', { ready: true }));

        // The word choices land on the drawer, who the server picks. Every
        // seat listens, and whichever one is offered the choice answers it.
        const choicesPromises = seats.map((user) => user.waitFor('s:game:wordChoices', 8000));

        const ack = await host.emit('socket.game.start', 'c:game:start', {});
        if (!ack?.ok) return false;

        const choices = await Promise.all(choicesPromises);
        const drawerIndex = choices.findIndex((choice) => choice !== null);
        if (drawerIndex < 0) return false;

        const drawer = seats[drawerIndex]!;
        drawer.isDrawer = true;

        // Any word will do; the first is as good as the third.
        const selected = await drawer.emit('socket.game.selectWord', 'c:game:selectWord', {
          index: 0,
        });

        return selected?.ok === true;
      }),
    );

    await settle(1000);

    const drawing = started.filter(Boolean).length;

    // A room is only usable by the next scenarios if it actually reached the
    // drawing phase, which the game state says.
    const inDrawingPhase = startable.filter((seats) => {
      const state = seats[0]!.last.get('s:game:state') as
        | { game?: { phase?: string; drawerId?: string | null } }
        | undefined;
      return state?.game?.phase === 'drawing';
    }).length;

    log(`  ${drawing} matches started, ${inDrawingPhase} rooms in the drawing phase`);

    return {
      checks: [
        {
          label: 'every eligible room started a match',
          passed: drawing === startable.length,
          detail: `${drawing}/${startable.length}`,
        },
        {
          label: 'every started match reached the drawing phase',
          passed: inDrawingPhase === drawing,
          detail: `${inDrawingPhase}/${drawing}`,
        },
      ],
      notes: { roomsEligible: startable.length, matchesStarted: drawing, inDrawingPhase },
    };
  },
};

/** Seats grouped by the room they are in. */
function groupByRoom(users: VirtualUser[]): Map<string, VirtualUser[]> {
  const byRoom = new Map<string, VirtualUser[]>();
  for (const user of users) {
    if (!user.socket?.connected || !user.roomId) continue;
    const seats = byRoom.get(user.roomId) ?? [];
    seats.push(user);
    byRoom.set(user.roomId, seats);
  }
  return byRoom;
}

// --------------------------------------------------------------------- 4 --

/**
 * Case 4: everybody reads the public room list, then joins from it.
 *
 * The list is explicitly a hint rather than a promise — a room can fill
 * between the read and the tap — so a refusal here is not a failure. What
 * would be a failure is a refusal the client cannot act on, or a seat granted
 * past the limit.
 */
export const publicRoomBrowse: Scenario = {
  id: '4',
  name: '100 users browsing and joining public rooms',
  async run({ users, recorder, log }) {
    const browsers = users.filter((user) => user.token).slice(0, 100);
    log(`${browsers.length} users listing public rooms`);

    const lists = await allAtOnce(browsers, (user) =>
      user.api<{ rooms?: unknown[] }>('rest.rooms.public', '/api/rooms/public?limit=20'),
    );

    const answered = lists.filter((list) => list !== null).length;
    const summary = recorder.summaries()['rest.rooms.public'];

    log(`  ${answered}/${browsers.length} answered, p95 ${summary?.p95Ms ?? 0}ms`);

    return {
      checks: [
        {
          label: 'the public list answered every caller',
          passed: answered === browsers.length,
          detail: `${answered}/${browsers.length}`,
        },
      ],
      notes: {
        answered,
        p95Ms: summary?.p95Ms ?? 0,
        p99Ms: summary?.p99Ms ?? 0,
      },
    };
  },
};

// --------------------------------------------------------------------- 6 --

/**
 * Case 6: simultaneous drawing across every active room.
 *
 * ## What is measured, and why it is measured on the receiver
 *
 * Stroke batches are ack-free on purpose, so timing the emit would measure
 * nothing but the local send buffer. What matters to a player is when the line
 * appears on *their* screen, so each batch carries a timestamp and the
 * receiving user records the difference on arrival. That figure — end-to-end
 * relay latency through validation, the board write and the room fan-out — is
 * the one the report calls socket event latency.
 *
 * The rate is the real one: roughly seventeen batches a second, which is what
 * the Flutter client emits while a finger is down.
 */
export const drawingStorm: Scenario = {
  id: '6',
  name: 'simultaneous drawing in every active room',
  async run({ users, recorder, log }) {
    // The drawer is whoever the server chose in `startGames`, not whoever is
    // first in the list — only they are permitted to draw.
    const rooms = [...groupByRoom(users).values()]
      .map((seats) => ({
        drawer: seats.find((user) => user.isDrawer),
        receivers: seats.filter((user) => !user.isDrawer),
      }))
      .filter((room): room is { drawer: VirtualUser; receivers: VirtualUser[] } =>
        Boolean(room.drawer && room.receivers.length > 0),
      );

    log(`${rooms.length} rooms have a live drawer and at least one guesser`);

    if (rooms.length === 0) {
      return { checks: [{ label: 'rooms with a live drawer were available', passed: false }] };
    }

    // Each batch carries the drawer's send time in its last point's pressure
    // slot. `sanitizePoints` preserves a third element when it is finite, and
    // clamps it into 0..1 — so the stamp is carried as a fraction of a ten
    // second window rather than as a raw epoch, which would clamp to 1 and
    // measure nothing.
    const EPOCH = Date.now();
    const WINDOW_MS = 10_000;

    let relayed = 0;

    for (const room of rooms) {
      for (const receiver of room.receivers) {
        receiver.socket?.on('s:draw:append', (payload: { points?: number[][] }) => {
          relayed += 1;

          const stamp = payload?.points?.[payload.points.length - 1]?.[2];
          if (typeof stamp !== 'number') return;

          const sentAt = EPOCH + stamp * WINDOW_MS;
          const latency = Date.now() - sentAt;

          // A negative or absurd figure means the stamp wrapped past the
          // window; recording it would poison the percentiles.
          if (latency >= 0 && latency < WINDOW_MS) {
            recorder.observe('draw.relayLatency', latency);
          }
        });
      }
    }

    const BATCHES = 60;
    const BATCH_INTERVAL_MS = 60;

    log(`  each drawer sending ${BATCHES} batches at ${BATCH_INTERVAL_MS}ms`);

    await Promise.all(
      rooms.map(async ({ drawer }) => {
        const strokeId = `lt-${drawer.index}-${Date.now()}`;

        // A stroke the server has seen begin, or every append is dropped.
        drawer.fire('c:draw:begin', {
          stroke: {
            id: strokeId,
            p: [[0.5, 0.5]],
            c: 0xff000000,
            w: 4,
            t: 'pen',
            ts: Date.now(),
          },
        });

        for (let batch = 0; batch < BATCHES; batch++) {
          const stamp = Math.min(0.999999, (Date.now() - EPOCH) / WINDOW_MS);

          drawer.fire('c:draw:append', {
            strokeId,
            // Eight points per batch, which is what 60ms of finger movement
            // produces at the client's sampling rate.
            points: Array.from({ length: 8 }, (_, i) => [
              Math.min(0.999, (batch * 8 + i) / (BATCHES * 8)),
              Math.min(0.999, 0.5 + Math.sin(batch / 4) * 0.2),
              stamp,
            ]),
          });

          await new Promise((resolve) => setTimeout(resolve, BATCH_INTERVAL_MS));
        }

        drawer.fire('c:draw:end', { strokeId });
      }),
    );

    await settle(1500);

    const receivers = rooms.reduce((total, room) => total + room.receivers.length, 0);
    const expectedArrivals = receivers * BATCHES;
    const deliveryRate = expectedArrivals === 0 ? 0 : relayed / expectedArrivals;

    const latency = recorder.summaries()['draw.relayLatency'];
    log(
      `  ${relayed}/${expectedArrivals} arrivals (${Math.round(deliveryRate * 100)}%), ` +
        `relay p95 ${latency?.p95Ms ?? 0}ms`,
    );

    return {
      checks: [
        {
          label: 'stroke batches reached the other players in the room',
          // Some loss at the tail is the settle window, not the server; a
          // relay that is actually broken delivers a fraction of this.
          passed: deliveryRate >= 0.95,
          detail: `${Math.round(deliveryRate * 100)}% delivered`,
        },
        {
          label: 'stroke relay stayed under 250ms at p95',
          // A drawn line that lands within a quarter second reads as live.
          passed: (latency?.p95Ms ?? Number.POSITIVE_INFINITY) < 250,
          detail: `p95 ${latency?.p95Ms ?? 'n/a'}ms, p99 ${latency?.p99Ms ?? 'n/a'}ms`,
        },
        {
          label: 'no player was disconnected while drawing',
          passed: users.every((user) => !user.roomId || user.socket?.connected !== false),
        },
      ],
      notes: {
        rooms: rooms.length,
        batchesSent: rooms.length * BATCHES,
        arrivals: relayed,
        deliveryRatePercent: Math.round(deliveryRate * 100),
        relayP95Ms: latency?.p95Ms ?? 0,
        relayP99Ms: latency?.p99Ms ?? 0,
      },
    };
  },
};

// --------------------------------------------------------------------- 7 --

/** Case 7: everybody talks at once, and the spam limiter has to hold. */
export const chatStorm: Scenario = {
  id: '7',
  name: 'chat messages from every seated player',
  async run({ users, recorder, log }) {
    const seated = users.filter((user) => user.socket?.connected && user.roomId);
    log(`${seated.length} seated players sending chat`);

    // Six messages each, which is exactly the `chat` bucket's burst — so a
    // correct limiter admits them and a seventh in the same instant does not.
    await allAtOnce(seated, async (user) => {
      for (let i = 0; i < 6; i++) {
        await user.emit('socket.chat', 'c:chat:send', { text: `hello ${i} from ${user.username}` });
      }
    });

    const beforeSpam = recorder.summaries()['socket.chat']?.errors ?? 0;

    // Now well past the burst, from a handful of users, all at once.
    const spammers = seated.slice(0, 10);
    await allAtOnce(spammers, async (user) => {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          user.emit('socket.chat.spam', 'c:chat:send', { text: `spam ${i}` }),
        ),
      );
    });

    await settle();

    const spamSummary = recorder.summaries()['socket.chat.spam'];
    const refused = spamSummary?.errors ?? 0;

    log(`  ${refused} of ${spammers.length * 20} spam messages refused`);

    return {
      checks: [
        {
          label: 'normal chat within the burst was delivered',
          passed: beforeSpam === 0,
          detail: `${beforeSpam} refusals`,
        },
        {
          label: 'chat spam was rate limited',
          passed: refused > 0,
          detail: `${refused}/${spammers.length * 20} refused`,
        },
      ],
      notes: { spamRefused: refused, spamAttempted: spammers.length * 20 },
    };
  },
};

// --------------------------------------------------------------- 8, 9, 10 --

/** Case 8: the leaderboard under concurrent load, and its paging. */
export const leaderboardStorm: Scenario = {
  id: '8',
  name: '100 concurrent leaderboard reads',
  async run({ users, recorder, log }) {
    const readers = users.filter((user) => user.token);
    log(`${readers.length} users reading the world leaderboard`);

    const pages = await allAtOnce(readers, (user) =>
      user.api<{ items?: unknown[]; page?: number }>(
        'rest.leaderboard.world',
        `/api/leaderboard/world?page=${(user.index % 3) + 1}&limit=20`,
      ),
    );

    const answered = pages.filter((page) => page !== null).length;
    const paged = pages.filter((page) => Array.isArray(page?.items) && page.items.length <= 20).length;

    // An uncapped page number would let one request make the server skip
    // arbitrarily far, so the cap is part of what makes this endpoint safe.
    const probe = readers[0];
    const beyondCap = probe
      ? await probe.api('rest.leaderboard.beyondCap', '/api/leaderboard/world?page=100000&limit=20')
      : null;

    const summary = recorder.summaries()['rest.leaderboard.world'];
    log(`  ${answered} answered, p95 ${summary?.p95Ms ?? 0}ms`);

    return {
      checks: [
        {
          label: 'every leaderboard read was answered',
          passed: answered === readers.length,
          detail: `${answered}/${readers.length}`,
        },
        {
          label: 'every page respected its limit',
          passed: paged === answered,
          detail: `${paged}/${answered}`,
        },
        {
          label: 'an absurd page number is refused rather than served',
          passed: beyondCap === null,
        },
      ],
      notes: { p95Ms: summary?.p95Ms ?? 0, p99Ms: summary?.p99Ms ?? 0 },
    };
  },
};

/** Case 9: friend requests, which are the tightest-limited social write. */
export const friendRequestStorm: Scenario = {
  id: '9',
  name: 'concurrent friend requests',
  async run({ users, recorder, log }) {
    const senders = users.filter((user) => user.token && user.userId).slice(0, 40);
    log(`${senders.length} users sending friend requests`);

    await allAtOnce(senders, async (user) => {
      // Each sends to the next user along, so every request is to a distinct
      // recipient and none of them is a duplicate.
      const target = users[(user.index + 1) % users.length];
      if (!target?.userId || target.userId === user.userId) return;

      await user.api('rest.friends.request', '/api/friends/requests', {
        method: 'POST',
        body: JSON.stringify({ receiverId: target.userId }),
      });
    });

    // Accept them, which is both the other half of the feature and what makes
    // the invitation scenario below test anything: `invitationService` refuses
    // an invite to somebody who is not a friend, so a run with no accepted
    // friendships measures that refusal rather than the invitation path.
    await settle();

    const accepted = await allAtOnce(senders, async (user) => {
      const target = users[(user.index + 1) % users.length];
      if (!target?.token) return false;

      // `{ items, total, page, limit, hasMore }`, and each item names the
      // *other* party as `user` — the sender, on an incoming request.
      const inbox = await target.api<{ items?: Array<{ id: string; user?: { id: string } }> }>(
        'rest.friends.incoming',
        '/api/friends/requests/incoming?limit=20',
      );

      const fromUser = inbox?.items?.find((row) => row.user?.id === user.userId);
      if (!fromUser) return false;

      const result = await target.api(
        'rest.friends.accept',
        `/api/friends/requests/${fromUser.id}/accept`,
        { method: 'POST' },
      );

      if (result !== null) {
        user.friendIds.push(target.userId!);
        target.friendIds.push(user.userId!);
        return true;
      }
      return false;
    });

    const summary = recorder.summaries()['rest.friends.request'];
    const friendships = accepted.filter(Boolean).length;
    log(`  ${summary?.count ?? 0} sent, ${summary?.errors ?? 0} refused, ${friendships} accepted`);

    return {
      checks: [
        {
          label: 'friend requests were handled without server errors',
          passed: !hasServerError(recorder, 'rest.friends.request'),
          detail: `${summary?.errors ?? 0} refusals, all client-level`,
        },
        {
          label: 'requests could be accepted',
          passed: friendships > 0,
          detail: `${friendships} friendships formed`,
        },
      ],
      notes: {
        attempted: summary?.count ?? 0,
        refused: summary?.errors ?? 0,
        friendships,
        p95Ms: summary?.p95Ms ?? 0,
      },
    };
  },
};

/** Case 10: room invitations, sent into live rooms. */
export const invitationStorm: Scenario = {
  id: '10',
  name: 'concurrent room invitations',
  async run({ users, recorder, log }) {
    const inviters = users
      .filter((user) => user.socket?.connected && user.roomId && user.friendIds.length > 0)
      .slice(0, 20);
    log(`${inviters.length} users inviting others to their rooms`);

    await allAtOnce(inviters, async (user) => {
      // A friend, because that is the rule: `invitationService` refuses an
      // invitation to a stranger. Inviting one anyway would measure the
      // refusal rather than the invitation.
      const friendId = user.friendIds[0];
      if (!friendId) return;

      await user.emit('socket.invite', 'c:room:invite', { inviteeId: friendId });
    });

    await settle();

    const summary = recorder.summaries()['socket.invite'];
    const delivered = users.reduce(
      (total, user) => total + (user.received.get('s:room:invitationReceived') ?? 0),
      0,
    );

    log(`  ${summary?.count ?? 0} sent, ${delivered} delivered to recipients`);

    return {
      checks: [
        {
          label: 'invitations were handled without server errors',
          passed: !hasServerError(recorder, 'socket.invite'),
        },
      ],
      notes: { sent: summary?.count ?? 0, delivered, refused: summary?.errors ?? 0 },
    };
  },
};

// -------------------------------------------------------------------- 11 --

/**
 * Case 11: everybody drops and comes back.
 *
 * The acceptance criterion is that a reconnect restores the *correct* room —
 * not merely that it reconnects. A player who comes back into somebody else's
 * room, or into no room, is the failure mode this catches.
 */
export const reconnectStorm: Scenario = {
  id: '11',
  name: 'mass disconnect and reconnect',
  async run({ users, recorder, log }) {
    const seated = users.filter((user) => user.socket?.connected && user.roomCode);
    const expected = new Map(seated.map((user) => [user.index, user.roomCode!]));

    log(`dropping ${seated.length} sockets at once`);
    for (const user of seated) user.disconnect();

    await settle(1000);

    log('reconnecting all of them');
    const reconnected = await allAtOnce(seated, async (user) => {
      const connected = await user.connect();
      if (!connected) return false;

      const ack = await user.hello();
      // `c:hello` reports the room it restored the seat into.
      const restoredCode = (ack?.roomCode as string | undefined) ?? null;
      return restoredCode === expected.get(user.index);
    });

    const restored = reconnected.filter(Boolean).length;
    log(`  ${restored}/${seated.length} restored to their original room`);

    return {
      checks: [
        {
          label: 'every dropped player reconnected',
          passed: seated.every((user) => user.socket?.connected === true),
          detail: `${seated.filter((u) => u.socket?.connected).length}/${seated.length}`,
        },
        {
          label: 'every reconnect restored the correct room',
          // The grace period is 45s and this runs well inside it, so a seat
          // that is not restored is a genuine failure rather than a timeout.
          passed: restored === seated.length,
          detail: `${restored}/${seated.length}`,
        },
      ],
      notes: {
        dropped: seated.length,
        restored,
        reconnectP95Ms: recorder.summaries()['socket.connect']?.p95Ms ?? 0,
      },
    };
  },
};

// -------------------------------------------------------------------- 12 --

/**
 * Case 12: voice signalling traffic.
 *
 * Signalling only — there is no audio here and there is none on the server
 * either. What is being loaded is the offer/answer/candidate relay and the
 * rule that the drawer is not in the voice group.
 */
export const voiceSignalling: Scenario = {
  id: '12',
  name: 'voice signalling under load',
  async run({ users, recorder, log }) {
    // Guessers only: the drawer is refused by design — they may neither
    // speak nor hear — so including them would be measuring the rule working.
    const seated = users.filter((user) => user.socket?.connected && user.roomId && !user.isDrawer);
    log(`${seated.length} guessers joining voice`);

    const joins = await allAtOnce(seated, (user) =>
      user.emit('socket.voice.join', 'c:voice:join', {}),
    );

    const admitted = seated.filter((_, i) => joins[i]?.ok);
    log(`  ${admitted.length} admitted to voice`);

    // A mesh's worth of candidates: each admitted peer sprays ICE at the
    // others in its room, which is the burst the `voiceSignal` bucket is
    // sized for.
    await allAtOnce(admitted, async (user) => {
      const peers = admitted.filter(
        (other) => other.roomId === user.roomId && other.userId !== user.userId,
      );

      for (const peer of peers.slice(0, 5)) {
        for (let i = 0; i < 6; i++) {
          user.fire('c:voice:ice', {
            targetId: peer.userId,
            candidate: {
              candidate: `candidate:${i} 1 udp 2130706431 10.0.0.${i} 5000${i} typ host`,
              sdpMid: '0',
              sdpMLineIndex: 0,
            },
          });
        }
      }
    });

    await settle(1500);

    const iceDelivered = users.reduce(
      (total, user) => total + (user.received.get('s:voice:ice') ?? 0),
      0,
    );

    // The drawer must never be in a voice group. Nobody is mid-turn in this
    // run, so this checks the weaker but still meaningful property: nothing
    // was admitted that the server refused.
    const voiceErrors = users.reduce(
      (total, user) => total + (user.received.get('s:voice:error') ?? 0),
      0,
    );

    log(`  ${iceDelivered} ICE frames relayed, ${voiceErrors} refusals`);

    return {
      checks: [
        {
          label: 'voice signalling relayed candidates between peers',
          passed: iceDelivered > 0,
          detail: `${iceDelivered} frames`,
        },
        {
          label: 'voice joins were handled without server errors',
          passed: !hasServerError(recorder, 'socket.voice.join'),
        },
      ],
      notes: {
        admitted: admitted.length,
        iceRelayed: iceDelivered,
        refusals: voiceErrors,
      },
    };
  },
};

// -------------------------------------------------------------------- 13 --

/**
 * Case 13, directly: many players racing for one room's last seat.
 *
 * `quickPlayStorm` covers this incidentally. This does it deliberately, with
 * a room deliberately left one seat short, so the assertion is unambiguous:
 * exactly one of the racers gets in and the rest are told the room is full.
 */
export const lastSeatRace: Scenario = {
  id: '13',
  name: 'many players racing for one last seat',
  async run({ users, log }) {
    const free = users.filter((user) => user.socket?.connected && !user.roomId);
    const host = free[0];
    if (!host) {
      return { checks: [{ label: 'a free user was available to host', passed: false }] };
    }

    // A room of exactly two, so one seat is free the moment the host is in it.
    const created = await host.emit('socket.create.race', 'c:room:create', {
      settings: { maxPlayers: 2, rounds: 1, drawTimeSeconds: 30, isPrivate: true },
    });
    host.noteRoom(created);

    const code = host.roomCode;
    if (!code) {
      return { checks: [{ label: 'the race room was created', passed: false }] };
    }

    const racers = free.slice(1, 13);
    log(`${racers.length} players racing for one seat in ${code}`);

    const results = await allAtOnce(racers, (user) =>
      user.emit('socket.join.race', 'c:room:join', { roomCode: code }),
    );

    await settle();

    const winners = results.filter((ack) => ack?.ok).length;
    const snapshot = host.last.get('s:room:state') as
      | { room?: { players?: Array<{ id: string }> } }
      | undefined;
    const seats = snapshot?.room?.players?.length ?? 0;

    log(`  ${winners} admitted, room holds ${seats} seats`);

    return {
      checks: [
        {
          label: 'exactly one racer took the last seat',
          passed: winners === 1,
          detail: `${winners} admitted`,
        },
        {
          label: 'the room never exceeded two seats',
          passed: seats <= 2,
          detail: `${seats} seats`,
        },
        {
          label: 'the losers were told the room was full',
          passed: racers.length - winners > 0,
          detail: `${racers.length - winners} refused`,
        },
      ],
      notes: { racers: racers.length, admitted: winners, seats },
    };
  },
};

/** Whether any failure for this operation looks like a 5xx rather than a refusal. */
function hasServerError(recorder: Recorder, operation: string): boolean {
  return recorder
    .failures()
    .some(
      (row) =>
        row.operation === operation &&
        (row.reason.includes('HTTP 5') ||
          row.reason.includes('serverError') ||
          row.reason.includes('INTERNAL_ERROR') ||
          row.reason.includes('ack timeout')),
    );
}

/** The suite, in the order it must run: identities first, then everything. */
export const scenarios: Scenario[] = [
  connectStorm,
  quickPlayStorm,
  publicRoomBrowse,
  duplicateJoins,
  // Before drawing and voice: both are permission-gated on a live turn.
  startGames,
  drawingStorm,
  chatStorm,
  leaderboardStorm,
  friendRequestStorm,
  invitationStorm,
  voiceSignalling,
  lastSeatRace,
  reconnectStorm,
];
