import { getSocketServer } from '@/config/socket';
import { gameAdapters } from '@/games/adapters';
import { isGameId, type GameId } from '@/games/game.types';
import { spaceMysteryEngine } from '@/games/spaceMystery/engine';
import { platformVoiceService } from '@/services/platformVoice.service';
import { rematchService } from '@/services/rematch.service';
import { gamePlatformService } from '@/services/game_platform.service';
import { on } from '@/socket/handler';
import type { GameSocket } from '@/types/socket.types';
import { errors } from '@/utils/errors';

const platformChannel = (roomId: string): string => `platform-game:${roomId}`;
type Payload = Record<string, unknown>;

/** Common realtime transport for card, deduction and board game adapters. */
export function registerPlatformGameHandlers(socket: GameSocket): void {
  // A dropped connection leaves a voice member nobody can hear and a peer
  // connection the others are still holding open. Registered first so it is
  // in place however early the socket dies.
  socket.on('disconnect', () => platformVoiceService.forget(socket));

  on(socket, 'game:room_created', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId);
    const room = await gamePlatformService.createRoom({
      gameId, owner: active.data.user, isPrivate: body.isPrivate === true,
      maxPlayers: numberOrUndefined(body.maxPlayers),
    });
    enter(active, room.roomId); active.emit('game:room_created', { room });
    return { room };
  }, { limit: 'createRoom' });

  on(socket, 'game:player_joined', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId); const roomKey = text(body.roomId) || text(body.roomCode);
    if (!roomKey) throw errors.validation('A room id or room code is required.');
    const room = await gamePlatformService.joinRoom(gameId, roomKey, active.data.user);
    enter(active, room.roomId); await broadcastRoom(gameId, room.roomId, 'game:player_joined');
    return { room };
  }, { limit: 'joinRoom' });

  /**
   * Attaches this socket to a room the caller is **already** a member of.
   *
   * ## Why this had to exist
   *
   * Rooms are created and joined over REST — `POST /api/games/:id/rooms` and
   * friends — because that is where the lobby lives. But a REST call has no
   * socket attached to it, so nothing in it can put this connection into the
   * `platform-game:<roomId>` channel, and every broadcast the match makes
   * would be sent to a channel this player is not in. The lobby worked and the
   * game never arrived.
   *
   * `game:player_joined` would technically do it, since seating an existing
   * player is idempotent — but it also announces a join to the whole room, so
   * every reconnect would tell everybody that somebody had walked in. This
   * says the true thing instead: *I am already here, start sending me things.*
   *
   * It is also the reconnect seam. A client that drops and comes back calls
   * this and is handed the current room and its own view of the match, rather
   * than waiting for the next thing to happen.
   */
  on(socket, 'game:subscribe', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId);
    const roomId = text(body.roomId) || active.data.platformRoomId || '';
    if (!roomId) throw errors.validation('A room id is required.');

    // Membership is the server's to decide, and `roomSnapshot` plus this check
    // is the whole of it: a caller who is not seated is refused the channel.
    const room = await gamePlatformService.roomSnapshot(gameId, roomId);
    if (!room.players.some((player) => player.playerId === active.data.user.id)) {
      throw errors.notMember();
    }

    enter(active, room.roomId);

    // The match as this seat sees it, if there is one. Never another seat's
    // view: this goes through the same per-viewer projection as every push.
    const match = room.matchId
      ? await gamePlatformService
        .matchForViewer(gameId, room.matchId, active.data.user.id)
        .catch(() => null)
      : null;

    // Real-time games check this on every action, and a resubscribe is
    // exactly when it needs refreshing.
    if (room.matchId) active.data.platformMatchId = room.matchId;

    return { room, match };
  }, { limit: 'joinRoom' });

  on(socket, 'game:player_left', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId); const roomId = text(body.roomId) || active.data.platformRoomId || '';
    if (!roomId) throw errors.notMember();
    const room = await gamePlatformService.leaveRoom(gameId, roomId, active.data.user.id);
    active.leave(platformChannel(roomId)); active.data.platformRoomId = null; active.data.platformMatchId = null;
    await broadcastRoom(gameId, roomId, 'game:player_left'); return { room };
  }, { limit: 'action' });

  on(socket, 'game:player_ready', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId); const roomId = text(body.roomId) || active.data.platformRoomId || '';
    if (!roomId) throw errors.notMember();
    const result = await gamePlatformService.readyRoom(gameId, roomId, active.data.user.id, body.ready !== false);
    await broadcastRoom(gameId, roomId, result.started ? 'game:match_started' : 'game:player_ready'); return result;
  }, { limit: 'action' });

  on(socket, 'game:action', ({ socket: active }, value) => dispatchAction(active, asPayload(value)), { limit: 'action' });
  for (const [event, type] of Object.entries(SPECIFIC_ACTIONS)) {
    on(socket, event, ({ socket: active }, value) => dispatchAction(active, { ...asPayload(value), type }), { limit: 'action' });
  }

  // Movement has its own bucket, because it is the one action a player sends
  // continuously rather than deliberately. See `spaceMove` in the limit table.
  on(socket, 'space:move', ({ socket: active }, value) => (
    dispatchAction(active, { ...asPayload(value), type: 'move' })
  ), { limit: 'spaceMove' });

  on(socket, 'game:chat_message', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId); const roomId = text(body.roomId) || active.data.platformRoomId || '';
    if (!roomId) throw errors.notMember();
    const message = await gamePlatformService.sendChat(gameId, roomId, active.data.user, text(body.message));
    getSocketServer()?.to(platformChannel(roomId)).emit('game:chat_message', { message }); return { message };
  }, { limit: 'chat' });

  // --------------------------------------------------------------- rematch

  /**
   * Offering, and answering, another round at the same table.
   *
   * Both ack with the offer as it now stands, so the caller's own screen
   * updates from the reply rather than waiting for the broadcast — and
   * everybody else's updates from the broadcast, which carries the room.
   */
  on(socket, 'game:rematch_request', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId);
    const roomId = text(body.roomId) || active.data.platformRoomId || '';
    if (!roomId) throw errors.notMember();

    return { rematch: await rematchService.request(gameId, roomId, active.data.user.id) };
  }, { limit: 'action' });

  on(socket, 'game:rematch_respond', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId);
    const roomId = text(body.roomId) || active.data.platformRoomId || '';
    if (!roomId) throw errors.notMember();

    return {
      rematch: await rematchService.respond(
        gameId, roomId, active.data.user.id, body.accept === true,
      ),
    };
  }, { limit: 'action' });

  // ------------------------------------------------------------------ voice

  /**
   * WebRTC signalling for the platform games.
   *
   * ## What travels and what does not
   *
   * Membership and three kinds of session-negotiation string: offers, answers
   * and ICE candidates. No audio ever crosses this socket and none is ever
   * written to Mongo — once two players have exchanged an offer, an answer and
   * their candidates, their voices go directly phone to phone, or through a
   * TURN relay where a NAT forbids that.
   *
   * ## Why every frame is re-checked
   *
   * The question is not "was this caller allowed to join" but "is this caller
   * allowed *right now*", and right now changes mid-connection: a meeting on
   * the Meridian ends, a drinker at the bar runs out of glasses. So
   * `assertMayUseVoice` runs on every verb — a handful of lookups — and it is
   * what makes the exclusion of ghosts and spectators a guarantee rather than
   * a hidden button.
   *
   * ## Acks versus fire-and-forget
   *
   * Join, leave and mute ack, because the client needs a verdict before it
   * opens a microphone. Offer, answer and candidate do not: a round trip per
   * ICE candidate would add latency to connection setup for nothing. Their
   * failures arrive on `game:voice_error` instead, so a ghost hand-crafting an
   * offer is refused audibly rather than silently.
   */
  on(socket, 'game:voice_joined', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId);
    const roomId = text(body.roomId) || active.data.platformRoomId || '';
    if (!roomId) throw errors.notMember();

    // The joiner is handed the mesh it has to build plus this deployment's
    // ICE servers, in the ack rather than a push, so it has them the moment
    // its own join resolves.
    return platformVoiceService.join(gameId, roomId, active);
  }, { limit: 'voice', errorEvent: 'game:voice_error' });

  on(socket, 'game:voice_left', ({ socket: active }, value) => {
    const body = asPayload(value);
    const roomId = text(body.roomId) || active.data.platformVoiceRoomId || '';
    // Leaving is never refused. A client tearing voice down must always
    // succeed, including one that was already dropped by the reconciler.
    if (roomId) platformVoiceService.leave(roomId, active);
    return {};
  }, { limit: 'voice' });

  on(socket, 'game:player_muted', async ({ socket: active }, value) => {
    const body = asPayload(value);
    const gameId = parseGameId(body.gameId);
    const roomId = text(body.roomId) || active.data.platformVoiceRoomId || '';
    if (!roomId) throw errors.notMember();

    return platformVoiceService.setMuted(gameId, roomId, active, body.muted === true);
  }, { limit: 'voice', errorEvent: 'game:voice_error' });

  for (const event of VOICE_SIGNALS) {
    on(socket, event, async ({ socket: active }, value) => {
      const body = asPayload(value);
      const gameId = parseGameId(body.gameId);
      const roomId = text(body.roomId) || active.data.platformVoiceRoomId || '';
      const targetUserId = text(body.targetId) || text(body.targetUserId);
      if (!roomId) throw errors.notMember();
      if (!targetUserId) throw errors.validation('A target player is required.');

      // Addressed to one peer rather than broadcast to the room. The previous
      // relay sent every offer to everybody, so each client had to discard
      // frames that were never theirs — and anybody in the room, voice member
      // or not, received them.
      await platformVoiceService.relay({
        gameId, roomId, socket: active, event, targetUserId, payload: body,
      });
      return {};
    }, { limit: 'voiceSignal', errorEvent: 'game:voice_error' });
  }
}

async function dispatchAction(socket: GameSocket, body: Payload): Promise<Payload> {
  const gameId = parseGameId(body.gameId); const matchId = text(body.matchId);
  if (!matchId) throw errors.validation('A match id is required.');

  /**
   * A real-time game's actions never touch the database.
   *
   * `gamePlatformService.action` loads a match document, folds the action in
   * and saves it. That is right for a card game and ruinous for a ship: ten
   * movement messages a second per player would be a write per player per
   * hundred milliseconds to store a position that is stale four frames later.
   *
   * So these go straight into the simulation, which validates them against its
   * own copy of the world — where you are standing, whether you are on
   * cooldown, whether that console is yours — exactly as the adapters validate
   * a turn. Nothing is trusted here either; it is simply checked somewhere
   * that does not have to write to Mongo to do it.
   *
   * There is no reply and no broadcast from this path. The tick already sends
   * every watcher their own view ten times a second, and answering an action
   * separately would race it.
   */
  if (gameAdapters[gameId].realtime === true) {
    if (!(await isSeated(socket, gameId, matchId))) throw errors.notMember();
    spaceMysteryEngine.input(matchId, socket.data.user.id, body);
    return { accepted: true };
  }

  // The broadcast is the service's, not this handler's. It used to be here,
  // which meant a Stupid's turn — which never passes through a socket — was
  // applied and then told to nobody. See `GamePlatformService.action`.
  return gamePlatformService.action(gameId, matchId, socket.data.user.id, body);
}

function enter(socket: GameSocket, roomId: string): void {
  const previous = socket.data.platformRoomId;
  if (previous && previous !== roomId) socket.leave(platformChannel(previous));
  socket.join(platformChannel(roomId)); socket.data.platformRoomId = roomId;
}

async function broadcastRoom(gameId: GameId, roomId: string, event: string): Promise<void> {
  const server = getSocketServer(); if (!server) return;
  const room = await gamePlatformService.roomSnapshot(gameId, roomId);
  const sockets = await server.in(platformChannel(roomId)).fetchSockets();
  for (const peer of sockets) {
    const viewerId = peer.data.user?.id; if (!viewerId) continue;
    peer.emit('game:room_updated', { room, event });
    if (room.matchId) {
      const state = await gamePlatformService.matchForViewer(gameId, room.matchId, viewerId).catch(() => null);
      if (state) peer.emit(event === 'game:match_started' ? 'game:match_started' : 'game:match_state', state);
      if (event === 'game:match_completed' && state) peer.emit('game:match_completed', state);
    }
  }
}

/**
 * Whether this user is actually in this match.
 *
 * The one database read the real-time path keeps, and it earns its place: it
 * is the difference between "the server decides where you are" and "anybody
 * who knows a match id can move somebody around it". Cached per socket after
 * the first call, because the answer cannot change inside a match — a player
 * who leaves the room leaves the match with it.
 */
async function isSeated(socket: GameSocket, gameId: GameId, matchId: string): Promise<boolean> {
  if (socket.data.platformMatchId === matchId) return true;

  // `matchForViewer` already refuses a viewer who is not one of the room's
  // players, so its succeeding *is* the membership check.
  const state = await gamePlatformService
    .matchForViewer(gameId, matchId, socket.data.user.id)
    .catch(() => null);
  if (state === null) return false;

  socket.data.platformMatchId = matchId;
  return true;
}

/**
 * Hands the simulation a way to reach the people watching it.
 *
 * Module load, once, rather than per connection: there is one engine and one
 * socket server, and binding it inside `registerPlatformGameHandlers` would
 * rebind it for every socket that ever connects.
 */
/**
 * Lets the REST lobby reach the people sitting in a room.
 *
 * Creating a room, seating Stupids and readying up are HTTP calls, and an
 * HTTP call has no socket — so without this a host could add three bots and
 * be the only person able to see them. `broadcastRoom` is the same function
 * the socket handlers use, which is what stops the two paths drifting into
 * two different ideas of what a room update contains.
 */
gamePlatformService.bindNotifier(broadcastRoom);

/**
 * Hangs up the microphones the moment a meeting ends.
 *
 * Bound here rather than inside the engine because the engine must not import
 * a service that imports it — the same cycle the recorder and the broadcaster
 * are bound this way to avoid.
 */
spaceMysteryEngine.bindVoiceReconciler((_matchId, roomId) => {
  void platformVoiceService.reconcile('SPACE_MYSTERY', roomId).catch(() => {
    // A failed reconcile must never take a tick with it. The next state
    // change runs it again.
  });
});

spaceMysteryEngine.bindBroadcaster((matchId, roomId, build) => {
  const server = getSocketServer();
  if (!server) return;

  void (async () => {
    // Scoped to the match's own channel rather than every socket on the
    // process. At ten broadcasts a second per match the difference is between
    // work proportional to one ship and work proportional to the whole server.
    const sockets = await server.in(platformChannel(roomId)).fetchSockets();
    for (const peer of sockets) {
      const viewerId = peer.data.user?.id;
      if (!viewerId) continue;

      // Each watcher is sent a different object — that is the entire point of
      // the projection — so this cannot be a room-wide emit.
      peer.data.platformMatchId = matchId;
      peer.emit('space:state', build(viewerId));
    }
  })();
});

function parseGameId(value: unknown): GameId {
  if (typeof value !== 'string' || !isGameId(value)) throw errors.notFound('Game not found.');
  return value;
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function numberOrUndefined(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function asPayload(value: unknown): Payload { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {}; }

const SPECIFIC_ACTIONS: Readonly<Record<string, string>> = {
  'kazhutha:draw_card': 'draw_card', 'kazhutha:play_card': 'play_card',
  'bluff:declare': 'declare', 'bluff:challenge': 'challenge', 'bluff:react': 'react',
  'space:task': 'task', 'space:sabotage': 'sabotage', 'space:meeting': 'meeting', 'space:vote': 'vote',
  // The rest of the ship: walking, killing, reporting and venting.
  'space:eliminate': 'eliminate', 'space:report': 'report', 'space:vent': 'vent',
  'ludo:dice_rolled': 'roll', 'ludo:token_moved': 'move',
};
/**
 * The three verbs that carry a peer connection into being.
 *
 * Join, leave and mute are handled individually above because each has a
 * different shape; these three differ only in their name, so they share one
 * registration.
 */
const VOICE_SIGNALS = [
  'game:voice_offer',
  'game:voice_answer',
  'game:voice_ice_candidate',
] as const;
