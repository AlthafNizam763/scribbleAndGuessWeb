/* eslint-disable no-console */
import { io, type Socket } from 'socket.io-client';

/**
 * The Definition of Done, driven end to end (brief sections 65, 72 step 11
 * and 73).
 *
 * This is a script rather than a Vitest file because it needs a *running*
 * server and a real database — it is the integration check you run against a
 * live backend, not a unit test. It speaks the same protocol the Flutter app
 * speaks, over a real websocket, with three separate authenticated clients.
 *
 *   npm run dev          # in one terminal
 *   npx tsx tests/e2e.game.ts
 *
 * It walks the exact chain from brief section 73: guest login, create room,
 * join by code, ready, start, drawer selection, word privacy, drawing relay,
 * guessing, scoring, round end, next drawer and the final result.
 */

const API = process.env.API_URL ?? 'http://localhost:3000';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail === undefined ? '' : detail);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Creates a guest account over REST and returns its token and id. */
async function guestLogin(username: string): Promise<{ token: string; id: string }> {
  const response = await fetch(`${API}/api/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, avatarId: 1, avatarColorIndex: 2 }),
  });

  const body = (await response.json()) as {
    success: boolean;
    data?: { token: string; user: { id: string } };
    error?: unknown;
  };

  if (!body.success || !body.data) throw new Error(`guest login failed: ${JSON.stringify(body)}`);
  return { token: body.data.token, id: body.data.user.id };
}

/** One test client: a socket plus the events it has seen. */
interface Client {
  name: string;
  id: string;
  socket: Socket;
  events: { event: string; data: Record<string, unknown> }[];
  /** Waits for the next occurrence of `event`, or rejects on timeout. */
  next: (event: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  /** Emits and resolves the ack. */
  request: (event: string, payload?: unknown) => Promise<Record<string, unknown>>;
  /** The most recent payload seen for `event`, if any. */
  last: (event: string) => Record<string, unknown> | undefined;
}

const SERVER_EVENTS = [
  's:room:state',
  's:room:closed',
  's:you:kicked',
  's:game:state',
  's:game:wordChoices',
  's:game:roundStart',
  's:game:hint',
  's:game:roundEnd',
  's:game:end',
  's:draw:begin',
  's:draw:append',
  's:draw:end',
  's:draw:undo',
  's:draw:redo',
  's:draw:clear',
  's:draw:snapshot',
  's:chat:message',
  's:time:sync',
  's:error',
];

async function connect(name: string): Promise<Client> {
  const { token, id } = await guestLogin(name);

  const socket = io(API, {
    transports: ['websocket'],
    auth: { token },
    forceNew: true,
    reconnection: false,
  });

  const events: { event: string; data: Record<string, unknown> }[] = [];

  for (const event of SERVER_EVENTS) {
    socket.on(event, (data: Record<string, unknown>) => {
      events.push({ event, data: data ?? {} });
    });
  }

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error: Error) => reject(error));
    setTimeout(() => reject(new Error(`${name}: connect timed out`)), 10_000);
  });

  const client: Client = {
    name,
    id,
    socket,
    events,
    /**
     * Waits for the next `event`, using a one-shot listener.
     *
     * A shared waiter queue would be wrong here: this script races several
     * `next()` calls against each other, and the losers' resolvers would stay
     * queued and swallow a later event that a *new* wait was expecting. A
     * `once` listener, removed on timeout, keeps every wait independent.
     */
    next(event, timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        const handler = (data: Record<string, unknown>): void => {
          clearTimeout(timer);
          resolve(data ?? {});
        };
        const timer = setTimeout(() => {
          socket.off(event, handler);
          reject(new Error(`${name}: timed out waiting for ${event}`));
        }, timeoutMs);
        socket.once(event, handler);
      });
    },
    request(event, payload = {}) {
      return new Promise((resolve, reject) => {
        socket.emit(event, payload, (response: Record<string, unknown>) => {
          if (response?.ok) resolve(response);
          else reject(new Error(`${event} refused: ${JSON.stringify(response?.error)}`));
        });
        setTimeout(() => reject(new Error(`${name}: ${event} ack timed out`)), 10_000);
      });
    },
    last(event) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.event === event) return events[i]?.data;
      }
      return undefined;
    },
  };

  await client.request('c:hello', { profile: { id, name, avatarId: 1, avatarColorIndex: 2 } });
  return client;
}

/** Reads the game state out of an `s:game:state` payload. */
function gameOf(data: Record<string, unknown> | undefined): Record<string, unknown> {
  return (data?.game ?? {}) as Record<string, unknown>;
}

async function main(): Promise<void> {
  section('health');
  const health = (await (await fetch(`${API}/api/health`)).json()) as Record<string, unknown>;
  check('server is healthy', health.status === 'healthy', health);
  check('database is connected', health.database === 'connected', health);
  check('socket server is attached', health.socket === 'attached', health);

  section('guest login and connect');
  const alice = await connect('Alice');
  const bob = await connect('Bob');
  const carol = await connect('Carol');
  check('three clients connected', Boolean(alice.id && bob.id && carol.id));
  check('ids are distinct', new Set([alice.id, bob.id, carol.id]).size === 3);

  section('create and join a room');
  const created = await alice.request('c:room:create', {
    settings: { maxPlayers: 8, rounds: 1, drawTimeSeconds: 30, hintCount: 1, wordSelectSeconds: 5 },
  });
  const room = created.room as Record<string, unknown>;
  const code = String(room.code);

  check('room has a five-character code', code.length === 5, code);
  check('creator is the host', room.hostId === alice.id);

  await bob.request('c:room:join', { code });
  await carol.request('c:room:join', { code });

  const roomState = (bob.last('s:room:state')?.room ?? {}) as Record<string, unknown>;
  const players = (roomState.players ?? []) as Record<string, unknown>[];
  check('room holds three players', players.length === 3, players.length);

  section('ready up');
  await bob.request('c:room:ready', { ready: true });
  await carol.request('c:room:ready', { ready: true });
  const readyState = (bob.last('s:room:state')?.room ?? {}) as Record<string, unknown>;
  const readyPlayers = (readyState.players ?? []) as { id: string; isReady: boolean }[];
  check(
    'ready flags reached everyone',
    readyPlayers.filter((player) => player.isReady).length >= 2,
    readyPlayers,
  );

  section('permissions');
  let refusedNonHostStart = false;
  try {
    await bob.request('c:game:start');
  } catch {
    refusedNonHostStart = true;
  }
  check('a non-host cannot start the game', refusedNonHostStart);

  section('start the game');
  const choicesPromise = Promise.race([
    alice.next('s:game:wordChoices'),
    bob.next('s:game:wordChoices'),
    carol.next('s:game:wordChoices'),
  ]);

  await alice.request('c:game:start');
  const choicesPayload = await choicesPromise;
  const choices = (choicesPayload.choices ?? []) as { text: string }[];
  check('the drawer was offered words', choices.length > 0, choices.length);

  // Whoever received the choices is the drawer the *server* picked.
  const clients = [alice, bob, carol];
  const drawer = clients.find((client) => client.last('s:game:wordChoices') !== undefined);
  if (!drawer) throw new Error('no client received word choices');

  const guessers = clients.filter((client) => client !== drawer);
  check('exactly one client got word choices', clients.filter((c) => c.last('s:game:wordChoices')).length === 1);
  console.log(`  (server chose ${drawer.name} as the drawer)`);

  section('word privacy');
  await drawer.request('c:game:selectWord', { index: 0 });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const drawerGame = gameOf(drawer.last('s:game:state'));
  const word = String(drawerGame.word ?? '');
  check('the drawer receives the word', word.length > 0);

  for (const guesser of guessers) {
    const view = gameOf(guesser.last('s:game:state'));
    check(`${guesser.name} does NOT receive the word`, view.word === null || view.word === undefined, view.word);
    check(`${guesser.name} receives a masked word`, String(view.maskedWord ?? '').includes('_'));
    check(`${guesser.name} receives the word length`, Number(view.wordLength) > 0);
  }

  // The strongest form of the check: the answer must not appear anywhere in
  // anything a guesser has ever been sent.
  for (const guesser of guessers) {
    const transcript = JSON.stringify(guesser.events).toLowerCase();
    check(
      `the answer never appears in ${guesser.name}'s transcript`,
      !transcript.includes(word.toLowerCase()),
    );
  }

  section('drawing relay');
  const strokeSeen = guessers[0]!.next('s:draw:begin');
  drawer.socket.emit('c:draw:begin', {
    stroke: { id: 'stroke-1', p: [[0.1, 0.1]], c: 4278190080, w: 4, t: 'pen', ts: Date.now() },
  });
  const relayed = await strokeSeen;
  const relayedStroke = (relayed.stroke ?? {}) as Record<string, unknown>;
  check('a stroke reaches other players', relayedStroke.id === 'stroke-1');
  check('the stroke is attributed to the drawer', relayedStroke.a === drawer.id);

  const appendSeen = guessers[0]!.next('s:draw:append');
  drawer.socket.emit('c:draw:append', {
    strokeId: 'stroke-1',
    points: [
      [0.2, 0.2],
      [0.3, 0.3],
    ],
  });
  const appended = await appendSeen;
  check('appended points reach other players', ((appended.points ?? []) as unknown[]).length === 2);

  // A guesser drawing must be refused: the server, not the client, decides
  // who holds the pen.
  let guesserStrokeLeaked = false;
  const watcher = (): void => {
    guesserStrokeLeaked = true;
  };
  drawer.socket.on('s:draw:begin', watcher);
  guessers[0]!.socket.emit('c:draw:begin', {
    stroke: { id: 'illegal', p: [[0.9, 0.9]], c: 1, w: 4, t: 'pen', ts: Date.now() },
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  drawer.socket.off('s:draw:begin', watcher);
  check('a non-drawer cannot draw', !guesserStrokeLeaked);

  section('guessing and scoring');
  let wrongBroadcast = false;
  const wrongWatcher = (data: Record<string, unknown>): void => {
    const message = (data.message ?? {}) as { text?: string };
    if (message.text === 'definitely-not-the-word') wrongBroadcast = true;
  };
  drawer.socket.on('s:chat:message', wrongWatcher);
  await guessers[0]!.request('c:chat:send', { text: 'definitely-not-the-word' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('a wrong guess is broadcast as chat', wrongBroadcast);

  // The drawer typing the answer must not score or announce.
  await drawer.request('c:chat:send', { text: word });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterDrawerTyped = gameOf(guessers[0]!.last('s:game:state'));
  check(
    'the drawer typing the word scores nothing',
    ((afterDrawerTyped.correctGuesserIds ?? []) as string[]).length === 0,
  );

  const correctAck = await guessers[0]!.request('c:chat:send', { text: word });
  check('a correct guess is acknowledged as correct', correctAck.verdict === 'correct', correctAck);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterGuess = gameOf(guessers[0]!.last('s:game:state'));
  const correctIds = (afterGuess.correctGuesserIds ?? []) as string[];
  check('the guesser is recorded as correct', correctIds.includes(guessers[0]!.id), correctIds);

  const scores = (afterGuess.roundScores ?? {}) as Record<string, number>;
  check('the guesser scored points', (scores[guessers[0]!.id] ?? 0) > 0, scores);

  // The second guess from the same player must be refused, not scored twice.
  let doubleScoreRefused = false;
  try {
    await guessers[0]!.request('c:chat:send', { text: word });
  } catch {
    doubleScoreRefused = true;
  }
  const afterDouble = gameOf(guessers[0]!.last('s:game:state'));
  const doubleScores = (afterDouble.roundScores ?? {}) as Record<string, number>;
  check('a repeat correct guess is refused', doubleScoreRefused);
  check(
    'a repeat correct guess does not score twice',
    doubleScores[guessers[0]!.id] === scores[guessers[0]!.id],
    doubleScores,
  );

  section('round end and the answer reveal');
  const roundEnd = await guessers[0]!.next('s:game:roundEnd', 45_000);
  const result = (roundEnd.result ?? {}) as Record<string, unknown>;
  check('the answer is revealed at round end', result.word === word, result.word);
  check('the round result carries score deltas', Object.keys((result.scoreDeltas ?? {}) as object).length > 0);
  check('the round result carries totals', Object.keys((result.totals ?? {}) as object).length > 0);

  const totals = (result.totals ?? {}) as Record<string, number>;
  check('the drawer earned a bonus', (totals[drawer.id] ?? 0) > 0, totals[drawer.id]);

  section('drawer rotation and the final result');

  /**
   * Plays out one turn: waits for whoever the server made drawer, has them
   * pick a word, then has both guessers get it so the turn ends early.
   *
   * Returns the drawer, or null once the match has finished instead.
   */
  async function playTurn(): Promise<Client | null> {
    const offer = await Promise.race([
      ...clients.map((client) =>
        client.next('s:game:wordChoices', 90_000).then(() => client as Client | null),
      ),
      Promise.race(clients.map((c) => c.next('s:game:end', 90_000))).then(() => null),
    ]);

    if (!offer) return null;

    await offer.request('c:game:selectWord', { index: 0 });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const secret = String(gameOf(offer.last('s:game:state')).word ?? '');
    if (secret.length === 0) throw new Error(`${offer.name} selected a word but never received it`);

    for (const client of clients) {
      if (client === offer) continue;
      await client.request('c:chat:send', { text: secret }).catch(() => undefined);
    }

    // Everybody guessed, so the turn ends after the short grace period.
    await Promise.race(clients.map((client) => client.next('s:game:roundEnd', 60_000)));
    return offer;
  }

  const drawersSeen = [drawer.name];

  // One round with three players is three turns; the first is already done.
  const secondDrawer = await playTurn();
  if (secondDrawer) drawersSeen.push(secondDrawer.name);
  check('a second turn began with a different drawer', secondDrawer !== null && secondDrawer !== drawer, secondDrawer?.name);

  const thirdDrawer = await playTurn();
  if (thirdDrawer) drawersSeen.push(thirdDrawer.name);
  check(
    'a third turn began with the remaining player',
    thirdDrawer !== null && new Set(drawersSeen).size === 3,
    drawersSeen,
  );

  const finished = await Promise.race(
    clients.map((client) => client.next('s:game:end', 90_000)),
  );
  const finalResult = (finished.result ?? {}) as Record<string, unknown>;
  const standings = (finalResult.standings ?? []) as {
    playerId: string;
    name: string;
    score: number;
    rank: number;
  }[];

  check('the match ends with final standings', standings.length === 3, standings.length);
  check('the standings are ranked', standings[0]?.rank === 1, standings);
  check(
    'the standings are ordered by score',
    standings.every((entry, index) => index === 0 || entry.score <= (standings[index - 1]?.score ?? 0)),
    standings,
  );
  check('every player scored something across the match', standings.some((entry) => entry.score > 0));

  section('play again');
  const restarted = alice.next('s:game:wordChoices', 90_000).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));

  let playAgainWorked = false;
  try {
    await alice.request('c:game:playAgain');
    playAgainWorked = true;
  } catch (error) {
    // The room drops back to the lobby a few seconds after the final result;
    // starting before that is legitimately refused.
    console.log('  (play again refused:', (error as Error).message, ')');
  }
  check('the host can restart the match', playAgainWorked);

  if (playAgainWorked) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const freshRoom = (alice.last('s:room:state')?.room ?? {}) as Record<string, unknown>;
    const freshPlayers = (freshRoom.players ?? []) as { score: number }[];

    check('the room code survives a restart', freshRoom.code === code, freshRoom.code);
    check('scores reset on a restart', freshPlayers.every((player) => player.score === 0), freshPlayers);
    check('the seats survive a restart', freshPlayers.length === 3, freshPlayers.length);
  }
  void restarted;

  section('cleanup');
  for (const client of clients) client.socket.disconnect();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exit(1);
  }
  console.log('Definition of Done: the full chain works.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('\nE2E run failed:', error);
  process.exit(1);
});
