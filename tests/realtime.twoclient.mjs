import { io } from 'socket.io-client';

const REST = process.env.REST_URL ?? 'https://scribble-and-guess-web.vercel.app';
const SOCK = process.env.SOCK_URL ?? 'http://127.0.0.1:3001';

const pass = [];
const fail = [];
const ok = (m, extra = '') => { pass.push(m); console.log(`  PASS  ${m}${extra ? ' — ' + extra : ''}`); };
const no = (m, extra = '') => { fail.push(m); console.log(`  FAIL  ${m}${extra ? ' — ' + extra : ''}`); };

async function guestToken(username) {
  const r = await fetch(`${REST}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const j = await r.json();
  if (!j?.data?.token) throw new Error('no token: ' + JSON.stringify(j).slice(0, 200));
  return j.data.token;
}

const RECORDED = ['s:room:state', 's:game:state', 's:game:wordChoices', 's:game:roundStart', 's:game:roundEnd', 's:chat:message', 's:draw:begin', 's:draw:append', 's:time:sync'];

const connect = (token) => new Promise((resolve, reject) => {
  const s = io(SOCK, {
    transports: ['websocket'],
    auth: { token },
    forceNew: true,
    reconnection: true,
    timeout: 10000,
  });
  // Recorders are attached before 'connect' resolves: the server emits a seed
  // s:time:sync the moment the socket connects, and a listener attached after
  // the promise settles can race it.
  s.seen = new Map();
  for (const ev of RECORDED) {
    s.seen.set(ev, []);
    s.on(ev, (payload) => s.seen.get(ev).push(payload));
  }
  s.on('connect', () => resolve(s));
  s.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
  setTimeout(() => reject(new Error('connect timeout')), 12000);
});

const req = (s, ev, data = {}) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ ok: false, error: { message: 'ack timeout' } }), 9000);
  s.emit(ev, data, (res) => { clearTimeout(t); resolve(res ?? { ok: false, error: { message: 'empty ack' } }); });
});

const waitFor = (s, ev, ms = 9000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  s.once(ev, (p) => { clearTimeout(t); resolve(p); });
});

console.log(`REST  ${REST}`);
console.log(`SOCK  ${SOCK}\n`);

console.log('— auth —');
const [tokenA, tokenB] = await Promise.all([guestToken('ClientA'), guestToken('ClientB')]);
ok('two guest JWTs minted from the REST deployment');

console.log('\n— connection + JWT auth across deployments —');
let A;
let B;
try { A = await connect(tokenA); ok('Client A connected', A.id); }
catch (e) { no('Client A connected', e.message); process.exit(1); }
try { B = await connect(tokenB); ok('Client B connected', B.id); }
catch (e) { no('Client B connected', e.message); process.exit(1); }

try {
  await connect('not-a-real-jwt');
  no('a bad token is refused at the handshake');
} catch (e) { ok('a bad token is refused at the handshake', e.message.slice(0, 60)); }

const recA = A.seen;
const recB = B.seen;

console.log('\n— hello / clock sync —');
const helloA = await req(A, 'c:hello', { profile: { name: 'ClientA', avatarId: 1 } });
helloA.ok ? ok('A c:hello', `playerId=${helloA.playerId}`) : no('A c:hello', JSON.stringify(helloA));
const helloB = await req(B, 'c:hello', { profile: { name: 'ClientB', avatarId: 2 } });
helloB.ok ? ok('B c:hello', `playerId=${helloB.playerId}`) : no('B c:hello', JSON.stringify(helloB));
recA.get('s:time:sync').length ? ok('A received s:time:sync') : no('A received s:time:sync');

console.log('\n— room create / join (brief alias room:join) —');
const made = await req(A, 'c:room:create', { settings: { maxPlayers: 8, rounds: 2, drawTimeSeconds: 40, wordSelectSeconds: 10 } });
made.ok ? ok('A created a room', `code=${made.room?.code}`) : no('A created a room', JSON.stringify(made).slice(0, 250));
const code = made.room?.code;

const joined = await req(B, 'room:join', { code });
joined.ok ? ok('B joined via the alias "room:join"', `players=${joined.room?.players?.length}`) : no('B joined via "room:join"', JSON.stringify(joined).slice(0, 250));

await new Promise((r) => setTimeout(r, 800));
const aSees = recA.get('s:room:state').at(-1);
const aSeesB = (aSees?.room?.players ?? []).some((p) => p.name === 'ClientB');
aSeesB ? ok('A sees B (realtime broadcast)') : no('A sees B', JSON.stringify(aSees?.room?.players?.map((p) => p.name)));
const bSeesA = (joined.room?.players ?? []).some((p) => p.name === 'ClientA');
bSeesA ? ok('B sees A') : no('B sees A');

console.log('\n— ready + game start —');
const rA = await req(A, 'player:ready', { ready: true });
const rB = await req(B, 'player:ready', { ready: true });
(rA.ok && rB.ok) ? ok('both players ready (alias "player:ready")') : no('ready', JSON.stringify({ rA, rB }).slice(0, 250));

const started = await req(A, 'game:start', {});
started.ok ? ok('host started the game (alias "game:start")') : no('game:start', JSON.stringify(started).slice(0, 250));

await new Promise((r) => setTimeout(r, 6000)); // TIMING.startCountdownSeconds is 3s

console.log('\n— the word stays secret —');
const choicesA = recA.get('s:game:wordChoices');
const choicesB = recB.get('s:game:wordChoices');
const drawerIsA = choicesA.length > 0;
const drawerIsB = choicesB.length > 0;
(drawerIsA !== drawerIsB)
  ? ok('exactly one player received word choices', drawerIsA ? 'A is drawer' : 'B is drawer')
  : no('exactly one player received word choices', `A=${choicesA.length} B=${choicesB.length}`);

const drawer = drawerIsA ? A : B;
const guesser = drawerIsA ? B : A;
const recGuesser = drawerIsA ? recB : recA;
const choice = (drawerIsA ? choicesA : choicesB).at(-1);
const words = choice?.choices ?? choice?.words ?? [];
words.length ? ok('drawer received word options', JSON.stringify(words)) : no('drawer received word options', JSON.stringify(choice));

const word = typeof words[0] === 'string' ? words[0] : (words[0]?.text ?? words[0]?.word);
const picked = await req(drawer, 'game:select_word', { index: 0 });
picked.ok ? ok('drawer selected a word (alias "game:select_word")', word) : no('game:select_word', JSON.stringify(picked).slice(0, 250));

await new Promise((r) => setTimeout(r, 1200));
const guesserState = recGuesser.get('s:game:state').at(-1);
const leakedWord = guesserState?.game?.word ?? guesserState?.word;
(leakedWord == null) ? ok('non-drawer game state does NOT carry the answer') : no('answer leaked to non-drawer', String(leakedWord));

console.log('\n— drawing —');
drawer.emit('drawing:stroke', { id: 'stroke-1', p: [[0.1, 0.1]], c: 0xff111111, w: 6, t: 'pen', ts: Date.now() });
drawer.emit('drawing:stroke_batch', { strokeId: 'stroke-1', points: [[0.2, 0.2], [0.3, 0.35]] });
const gotDraw = (await waitFor(guesser, 's:draw:append', 5000)) ?? (recGuesser.get('s:draw:append') ?? []).at(-1);
gotDraw ? ok('guesser received the drawing in realtime') : no('guesser received the drawing');

console.log('\n— guessing —');
const guessAck = await req(guesser, 'guess:submit', { text: word });
guessAck.ok ? ok('guess accepted (alias "guess:submit")', JSON.stringify(guessAck).slice(0, 140)) : no('guess:submit', JSON.stringify(guessAck).slice(0, 250));
await new Promise((r) => setTimeout(r, 1000));
const chat = recA.get('s:chat:message').concat(recB.get('s:chat:message')).map((m) => m?.message ?? m);
const correct = chat.some((m) => m?.type === 'correctGuess');
correct ? ok('server broadcast the correct guess to the room') : no('server broadcast the correct guess', JSON.stringify(chat).slice(0, 300));
guessAck.verdict === 'correct' ? ok('server verdict is "correct"') : no('server verdict', String(guessAck.verdict));

console.log('\n— chat —');
const chatAck = await req(drawer, 'chat:message', { text: 'hello from the test' });
chatAck.ok ? ok('chat:message accepted from the drawer') : no('chat:message', JSON.stringify(chatAck).slice(0, 200));
const leakAck = await req(guesser, 'chat:message', { text: word });
(!leakAck.ok && /already guessed/i.test(leakAck.error?.message ?? ''))
  ? ok('a player who already guessed cannot chat the answer', leakAck.error.message)
  : no('anti-leak rule on chat', JSON.stringify(leakAck).slice(0, 200));

console.log('\n— reconnect —');
const before = B.id;
B.io.engine.close();
await new Promise((r) => setTimeout(r, 3000));
B.connected ? ok('B reconnected automatically', `${before} -> ${B.id}`) : no('B reconnected automatically');
const rehello = await req(B, 'c:hello', { profile: { name: 'ClientB', avatarId: 2 } });
(rehello.ok && rehello.roomCode) ? ok('seat restored on reconnect', `roomCode=${rehello.roomCode}`) : no('seat restored on reconnect', JSON.stringify(rehello).slice(0, 200));

console.log('\n— leave —');
const left = await req(B, 'room:leave', {});
left.ok ? ok('B left via alias "room:leave"') : no('room:leave', JSON.stringify(left).slice(0, 200));

A.close();
B.close();
console.log(`\n================  ${pass.length} passed, ${fail.length} failed  ================`);
if (fail.length) {
  console.log('failed:');
  fail.forEach((f) => console.log('  - ' + f));
}
process.exit(fail.length ? 1 : 0);
