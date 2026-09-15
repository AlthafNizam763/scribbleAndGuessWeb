/* eslint-disable no-console */
import { io, type Socket } from 'socket.io-client';

/**
 * Guesser-only voice chat, driven end to end with three real clients.
 *
 * A script rather than a Vitest file, for the same reason `e2e.game.ts` is
 * one: it needs a running server, a real database and three separate
 * authenticated websockets. `voice.test.ts` pins the rules against the
 * in-memory room; this pins them *on the wire*, which is where a client
 * actually meets them.
 *
 *   npm run dev                 # in one terminal
 *   npx tsx tests/e2e.voice.ts
 *
 * It plays the brief's own scenario — A draws while B and C guess, then the
 * pen moves — and then performs the brief's security test: emitting
 * `voice:join`, `voice:offer`, `voice:answer` and `voice:ice_candidate`
 * straight from the drawer's socket, under the brief's own event names, and
 * checking every one is refused with DRAWER_VOICE_DISABLED.
 *
 * No audio is involved. This is a signalling test: it verifies who the server
 * will let talk to whom, which is the whole of the security surface. Whether
 * two phones can actually hear each other is a WebRTC concern and needs real
 * devices — see the manual matrix in the README.
 */

/** Where guest login lives. */
const API = process.env.API_URL ?? 'http://localhost:3000';

/**
 * Where the websocket lives.
 *
 * Separable because the deployment separates them: the REST API is serverless
 * and cannot hold a socket open, so the realtime half runs on its own host
 * signing with the same `JWT_SECRET`. Pointing this at a second process is
 * also how the script is run against a locally rebuilt realtime server while
 * an existing one keeps serving REST.
 */
const SOCKET = process.env.SOCKET_URL ?? API;

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

/** An ack envelope, either shape. */
type Ack = {
  ok?: boolean;
  error?: { code?: string; message?: string; details?: { code?: string } };
  [key: string]: unknown;
};

async function guestLogin(username: string): Promise<{ token: string; id: string }> {
  const response = await fetch(`${API}/api/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, avatarId: 1, avatarColorIndex: 2 }),
  });

  const body = (await response.json()) as {
    success: boolean;
    data?: { token: string; user: { id: string } };
  };

  if (!body.success || !body.data) throw new Error(`guest login failed for ${username}`);
  return { token: body.data.token, id: body.data.user.id };
}

const SERVER_EVENTS = [
  's:room:state',
  's:game:state',
  's:game:wordChoices',
  's:game:roundStart',
  's:game:roundEnd',
  's:game:end',
  's:error',
  's:voice:state',
  's:voice:peerJoined',
  's:voice:peerLeft',
  's:voice:offer',
  's:voice:answer',
  's:voice:ice',
  's:voice:mute',
  's:voice:error',
];

interface Client {
  name: string;
  id: string;
  socket: Socket;
  events: { event: string; data: Record<string, unknown> }[];
  next: (event: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  /** Emits and resolves the ack, whatever it says. Never rejects on refusal. */
  ask: (event: string, payload?: unknown) => Promise<Ack>;
  last: (event: string) => Record<string, unknown> | undefined;
  clear: () => void;
}

async function connect(name: string): Promise<Client> {
  const { token, id } = await guestLogin(name);

  const socket = io(SOCKET, {
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
    // Deliberately resolving rather than rejecting on `ok: false`. Most of
    // this script is *expecting* refusals, and a helper that threw on them
    // would turn every assertion into a try/catch.
    ask(event, payload = {}) {
      return new Promise((resolve, reject) => {
        socket.emit(event, payload, (response: Ack) => resolve(response ?? {}));
        setTimeout(() => reject(new Error(`${name}: ${event} ack timed out`)), 10_000);
      });
    },
    last(event) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.event === event) return events[i]?.data;
      }
      return undefined;
    },
    clear() {
      events.length = 0;
    },
  };

  await new Promise<void>((resolve, reject) => {
    socket.emit(
      'c:hello',
      { profile: { id, name, avatarId: 1, avatarColorIndex: 2 } },
      (response: Ack) => (response?.ok ? resolve() : reject(new Error('hello refused'))),
    );
    setTimeout(() => reject(new Error(`${name}: hello timed out`)), 10_000);
  });

  return client;
}

/** Whether an ack was refused specifically because the caller is the drawer. */
function refusedAsDrawer(ack: Ack): boolean {
  return ack.ok === false && ack.error?.details?.code === 'DRAWER_VOICE_DISABLED';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A plausible offer. The server relays SDP without parsing it. */
const FAKE_SDP = {
  type: 'offer',
  sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
};

async function main(): Promise<void> {
  section('connect three clients');
  const alice = await connect('VoiceAlice');
  const bob = await connect('VoiceBob');
  const carol = await connect('VoiceCarol');
  const clients = [alice, bob, carol];
  check('three clients connected', new Set(clients.map((c) => c.id)).size === 3);

  section('create and join a room');
  const created = await alice.ask('c:room:create', {
    settings: { maxPlayers: 8, rounds: 2, drawTimeSeconds: 20, hintCount: 1, wordSelectSeconds: 5 },
  });
  const code = String((created.room as Record<string, unknown>).code);
  await bob.ask('c:room:join', { code });
  await carol.ask('c:room:join', { code });
  check('room created and joined', code.length === 5, code);

  section('voice is closed in the lobby');
  const lobbyJoin = await bob.ask('c:voice:join');
  check(
    'a guesser cannot join voice before a turn opens',
    lobbyJoin.ok === false,
    lobbyJoin.error,
  );

  section('start a turn');
  const choicesPromise = Promise.race(clients.map((c) => c.next('s:game:wordChoices')));
  await alice.ask('c:room:ready', { ready: true });
  await bob.ask('c:room:ready', { ready: true });
  await carol.ask('c:room:ready', { ready: true });
  await alice.ask('c:game:start');
  await choicesPromise;

  const drawer = clients.find((c) => c.last('s:game:wordChoices') !== undefined);
  if (!drawer) throw new Error('no client received word choices');
  const guessers = clients.filter((c) => c !== drawer);
  const [first, second] = guessers as [Client, Client];
  console.log(`  (the server chose ${drawer.name} to draw)`);

  await drawer.ask('c:game:selectWord', { index: 0 });
  await sleep(400);

  section('the drawer is told voice is off');

  // Every voice state this client has ever been sent said voice was off, and
  // handed it no ICE servers to connect with. Asserted over the whole
  // transcript rather than the latest frame, because a player who never
  // entered the voice group is never *pushed* a new one — they are told they
  // are the drawer by `s:game:state`, which is what their client reads. The
  // push matters for the player who has to be *removed* from voice, and that
  // is checked when the pen moves below.
  const drawerVoiceFrames = drawer.events.filter((e) => e.event === 's:voice:state');
  check('the drawer received a voice state', drawerVoiceFrames.length > 0);
  check(
    'every voice state the drawer saw said voice is off',
    drawerVoiceFrames.every((frame) => frame.data.enabled === false),
    drawerVoiceFrames.map((f) => f.data),
  );
  check(
    'the drawer was never given ICE servers',
    drawerVoiceFrames.every(
      (frame) =>
        Array.isArray(frame.data.iceServers) &&
        (frame.data.iceServers as unknown[]).length === 0,
    ),
    drawerVoiceFrames.map((f) => f.data.iceServers),
  );
  check(
    'the game state names this client as the drawer',
    ((drawer.last('s:game:state')?.game ?? {}) as { drawerId?: string }).drawerId === drawer.id,
  );

  section('SECURITY: the drawer is refused, under both event vocabularies');

  // The canonical names.
  for (const [event, payload] of [
    ['c:voice:join', {}],
    ['c:voice:offer', { targetId: first.id, description: FAKE_SDP }],
    ['c:voice:answer', { targetId: first.id, description: { ...FAKE_SDP, type: 'answer' } }],
    ['c:voice:ice', { targetId: first.id, candidate: { candidate: 'candidate:0 1 udp 1 1.2.3.4 1 typ host', sdpMid: '0', sdpMLineIndex: 0 } }],
    ['c:voice:mute', { muted: false }],
  ] as [string, unknown][]) {
    const ack = await drawer.ask(event, payload);
    check(`${event} from the drawer is refused with DRAWER_VOICE_DISABLED`, refusedAsDrawer(ack), ack.error);
  }

  // And the brief's own section 16 spellings, which the server aliases onto
  // the same handlers. A client hand-crafting these gets the same answer.
  for (const [event, payload] of [
    ['voice:join', {}],
    ['voice:offer', { targetId: first.id, description: FAKE_SDP }],
    ['voice:answer', { targetId: first.id, description: { ...FAKE_SDP, type: 'answer' } }],
    ['voice:ice_candidate', { targetId: first.id, candidate: null }],
  ] as [string, unknown][]) {
    const ack = await drawer.ask(event, payload);
    check(`alias ${event} from the drawer is refused`, refusedAsDrawer(ack), ack.error);
  }

  section('guessers join and see each other');
  const firstJoin = await first.ask('c:voice:join');
  check(`${first.name} was admitted`, firstJoin.ok === true, firstJoin.error);
  check(
    `${first.name} is given ICE servers`,
    Array.isArray(firstJoin.iceServers) && (firstJoin.iceServers as unknown[]).length > 0,
    firstJoin.iceServers,
  );
  check(
    `${first.name} sees no peers yet`,
    Array.isArray(firstJoin.peers) && (firstJoin.peers as unknown[]).length === 0,
  );

  const peerJoined = first.next('s:voice:peerJoined', 5000);
  const secondJoin = await second.ask('c:voice:join');
  check(`${second.name} was admitted`, secondJoin.ok === true, secondJoin.error);
  check(
    `${second.name} is handed ${first.name} as a peer`,
    ((secondJoin.peers ?? []) as { userId: string }[]).some((p) => p.userId === first.id),
    secondJoin.peers,
  );

  const announced = (await peerJoined) as { peer?: { userId?: string } };
  check(
    `${first.name} was told ${second.name} joined`,
    announced.peer?.userId === second.id,
    announced,
  );

  section('the drawer is never in the mesh');
  const drawerInPeers = ((secondJoin.peers ?? []) as { userId: string }[]).some(
    (p) => p.userId === drawer.id,
  );
  check('the drawer appears in nobody’s peer list', !drawerInPeers, secondJoin.peers);

  const toDrawer = await first.ask('c:voice:offer', {
    targetId: drawer.id,
    description: FAKE_SDP,
  });
  check(
    'a guesser cannot address the drawer either',
    refusedAsDrawer(toDrawer),
    toDrawer.error,
  );

  section('signalling flows between guessers');
  const offerArrives = second.next('s:voice:offer', 5000);
  const offerAck = await first.ask('c:voice:offer', {
    targetId: second.id,
    description: FAKE_SDP,
  });
  check('the offer was accepted', offerAck.ok === true, offerAck.error);

  const relayed = (await offerArrives) as { from?: string; description?: { sdp?: string } };
  check('the offer reached the other guesser', relayed.from === first.id, relayed);
  check('the SDP survived the relay intact', relayed.description?.sdp === FAKE_SDP.sdp);

  const answerArrives = first.next('s:voice:answer', 5000);
  await second.ask('c:voice:answer', {
    targetId: first.id,
    description: { ...FAKE_SDP, type: 'answer' },
  });
  const answer = (await answerArrives) as { from?: string };
  check('the answer came back', answer.from === second.id, answer);

  const iceArrives = second.next('s:voice:ice', 5000);
  await first.ask('c:voice:ice', {
    targetId: second.id,
    candidate: { candidate: 'candidate:0 1 udp 2130706431 192.0.2.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  });
  const candidate = (await iceArrives) as { from?: string };
  check('the ICE candidate was relayed', candidate.from === first.id, candidate);

  // The drawer has been listening to everything the whole time.
  const drawerSawVoice = drawer.events.some(
    (entry) =>
      entry.event.startsWith('s:voice:') && entry.event !== 's:voice:state' && entry.event !== 's:voice:error',
  );
  check('the drawer received no voice traffic at all', !drawerSawVoice);

  section('mute is published to the group');
  const muteArrives = first.next('s:voice:mute', 5000);
  const muteAck = await second.ask('c:voice:mute', { muted: true });
  check('mute was accepted', muteAck.ok === true, muteAck.error);
  const mute = (await muteArrives) as { userId?: string; muted?: boolean };
  check('the peer saw the mute', mute.userId === second.id && mute.muted === true, mute);

  section('the pen moves, and voice follows it');
  // Wait out the turn rather than forcing it: this is the transition the whole
  // feature turns on, and it has to work the way it will in a real game.
  console.log('  (waiting for the turn to end...)');
  for (const client of clients) client.clear();

  const nextDrawerChoices = await Promise.race(
    clients.map((c) => c.next('s:game:wordChoices', 60_000)),
  ).catch(() => null);
  check('a new turn opened', nextDrawerChoices !== null);

  await sleep(600);

  const newDrawer = clients.find((c) => c.last('s:game:wordChoices') !== undefined);
  check('a new drawer was chosen', newDrawer !== undefined);

  if (newDrawer) {
    console.log(`  (the pen moved to ${newDrawer.name})`);

    const state = newDrawer.last('s:voice:state');
    check(
      `${newDrawer.name} was told voice is off now that they draw`,
      state?.enabled === false && state?.isDrawer === true,
      state,
    );

    // Whoever drew last is a guesser now and must be allowed back in.
    if (newDrawer !== drawer) {
      const previousDrawerRejoin = await drawer.ask('c:voice:join');
      check(
        `${drawer.name} may speak now that they no longer draw`,
        previousDrawerRejoin.ok === true,
        previousDrawerRejoin.error,
      );
    }

    // And the new drawer is refused, on the same socket that was allowed a
    // moment ago. This is the case a client-side-only rule would miss.
    const newDrawerJoin = await newDrawer.ask('c:voice:join');
    check(
      `${newDrawer.name} is refused now that they hold the pen`,
      refusedAsDrawer(newDrawerJoin),
      newDrawerJoin.error,
    );
  }

  section('cleanup');
  for (const client of clients) client.socket.disconnect();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exit(1);
  }
  console.log('Voice chat: guessers talk, the drawer cannot, and the server is what enforces it.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('\nVoice E2E run failed:', error);
  process.exit(1);
});
