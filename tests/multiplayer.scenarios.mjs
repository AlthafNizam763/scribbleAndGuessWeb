/**
 * The multiplayer scenarios from the test brief, over the real protocol.
 *
 *   two players, three players, leave, rejoin, reconnect, concurrent joins,
 *   duplicate taps, and a host walking out mid-match.
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001';
let pass = 0;
let fail = 0;
const ok = (m, x = '') => { pass++; console.log(`  PASS  ${m}${x ? ' — ' + x : ''}`); };
const no = (m, x = '') => { fail++; console.log(`  FAIL  ${m}${x ? ' — ' + x : ''}`); };
const sec = (t) => console.log(`\n=== ${t} ===`);

async function rest(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 200) }; }
  return { status: r.status, json: j };
}

const guest = async (n) => (await rest('/api/auth/guest', { method: 'POST', body: { username: n } })).json.data;

const RECORDED = ['s:room:state', 's:game:state', 's:room:playerJoined', 's:room:playerLeft', 's:room:closed'];

const connect = (token) => new Promise((res, rej) => {
  const s = io(BASE, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false, timeout: 20000 });
  s.seen = {};
  for (const ev of RECORDED) {
    s.seen[ev] = [];
    s.on(ev, (p) => s.seen[ev].push(p));
  }
  const t = setTimeout(() => rej(new Error('connect timeout')), 21000);
  s.on('connect', () => { clearTimeout(t); res(s); });
  s.on('connect_error', (e) => { clearTimeout(t); rej(e); });
});

const req = (s, ev, d = {}) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, error: { message: 'ACK TIMEOUT' } }), 12000);
  s.emit(ev, d, (r) => { clearTimeout(t); res(r ?? { ok: false, error: { message: 'EMPTY ACK' } }); });
});

const hello = (s, n) => req(s, 'c:hello', { profile: { name: n, avatarId: 1, avatarColorIndex: 0 } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const roomOf = (ack) => ack.room ?? ack.data?.room ?? {};
const players = (ack) => roomOf(ack).players ?? [];

const st = Date.now().toString(36).slice(-5);

// ---------------------------------------------------------------- two players
sec('two players: create and join');
const A = await guest(`MA${st}`);
const B = await guest(`MB${st}`);
const C = await guest(`MC${st}`);
const sa = await connect(A.token); await hello(sa, `MA${st}`);
const sb = await connect(B.token); await hello(sb, `MB${st}`);

const created = await req(sa, 'c:room:create', {
  settings: { isPrivate: false, maxPlayers: 8, rounds: 2 },
  profile: { name: `MA${st}`, avatarId: 1, avatarColorIndex: 0 },
});
const code = roomOf(created).code;
created.ok ? ok('A created a room', code) : no('A created a room', JSON.stringify(created).slice(0, 200));

const joined = await req(sb, 'c:room:join', { code, profile: { name: `MB${st}`, avatarId: 2, avatarColorIndex: 1 } });
joined.ok && players(joined).length === 2
  ? ok('B joined, room holds two')
  : no('B joined', JSON.stringify(joined).slice(0, 200));
await wait(400);
sa.seen['s:room:playerJoined'].length > 0 ? ok('A was told B arrived') : no('A was told B arrived');

// ------------------------------------------------------- duplicate join taps
sec('duplicate join requests');
const dupes = await Promise.all([
  req(sb, 'c:room:join', { code, profile: { name: `MB${st}`, avatarId: 2, avatarColorIndex: 1 } }),
  req(sb, 'c:room:join', { code, profile: { name: `MB${st}`, avatarId: 2, avatarColorIndex: 1 } }),
  req(sb, 'c:room:join', { code, profile: { name: `MB${st}`, avatarId: 2, avatarColorIndex: 1 } }),
]);
const sizes = dupes.filter((r) => r.ok).map((r) => players(r).length);
sizes.length > 0 && sizes.every((n) => n === 2)
  ? ok('three simultaneous joins still seat one player', `sizes=${sizes.join(',')}`)
  : no('three simultaneous joins still seat one player', `sizes=${sizes.join(',')}`);

// -------------------------------------------------- concurrent distinct joins
sec('a third player joins');
const sc = await connect(C.token); await hello(sc, `MC${st}`);
const cj = await req(sc, 'c:room:join', { code, profile: { name: `MC${st}`, avatarId: 3, avatarColorIndex: 2 } });
cj.ok && players(cj).length === 3 ? ok('C joined, room holds three') : no('C joined', JSON.stringify(cj).slice(0, 200));

// ------------------------------------------------------------ ready and start
sec('ready and start');
await req(sa, 'c:room:ready', { ready: true });
await req(sb, 'c:room:ready', { ready: true });
await req(sc, 'c:room:ready', { ready: true });
const started = await req(sa, 'c:game:start');
started.ok ? ok('the host started the match') : no('the host started the match', JSON.stringify(started).slice(0, 250));
await wait(1500);

// --------------------------------------------------------- reconnect mid-match
sec('reconnect mid-match keeps the seat');
sc.close();
await wait(1500);
const sc2 = await connect(C.token);
const back = await hello(sc2, `MC${st}`);
back.ok && back.roomCode === code
  ? ok('c:hello put C back in the same room', back.roomCode)
  : no('c:hello put C back in the same room', JSON.stringify(back).slice(0, 200));
await wait(800);
sc2.seen['s:game:state'].length > 0 || sc2.seen['s:room:state'].length > 0
  ? ok('the returning client was resent the authoritative state')
  : no('the returning client was resent the authoritative state');

// ------------------------------------------------------------- player leaves
sec('a player leaves and the match continues');
const left = await req(sc2, 'c:room:leave');
left.ok ? ok('C left cleanly') : no('C left cleanly', JSON.stringify(left).slice(0, 200));
await wait(900);
sa.seen['s:room:playerLeft'].length > 0 ? ok('the room was told C left') : no('the room was told C left');
sa.seen['s:room:closed'].length === 0
  ? ok('the room stayed open with two players left')
  : no('the room stayed open with two players left');

// ---------------------------------------------------------- rejoin after leave
sec('rejoin after leaving');
const rejoin = await req(sc2, 'c:room:join', { code, profile: { name: `MC${st}`, avatarId: 3, avatarColorIndex: 2 } });
rejoin.ok ? ok('C rejoined by code', `players=${players(rejoin).length}`) : no('C rejoined by code', JSON.stringify(rejoin).slice(0, 250));

// -------------------------------------------------------------- host leaves
sec('the host walks out');
const hostBefore = roomOf(created).hostId;
await req(sa, 'c:room:leave');
await wait(1000);
const hostNow = (sb.seen['s:room:state'].at(-1) ?? {}).room?.hostId ?? (sb.seen['s:room:state'].at(-1) ?? {}).hostId;
hostNow && hostNow !== hostBefore
  ? ok('the host role passed to somebody still in the room', hostNow)
  : no('the host role passed to somebody still in the room', `before=${hostBefore} now=${hostNow}`);

// ----------------------------------------------------------- everybody leaves
sec('the last player out closes the room');
await req(sb, 'c:room:leave');
await req(sc2, 'c:room:leave');
await wait(1000);
const gone = await req(sb, 'c:room:join', { code, profile: { name: `MB${st}`, avatarId: 2, avatarColorIndex: 1 } });
!gone.ok ? ok('the emptied room is gone', gone.error?.message) : no('the emptied room is gone', 'it was still joinable');

sa.close(); sb.close(); sc2.close();
console.log(`\n${pass}/${pass + fail} checks passed${fail ? `  ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
