import { emitToRoom, removeUserFromRoomChannel } from '@/config/socket';
import {
  CLIENT_ROOM_BAN,
  CLIENT_ROOM_CREATE,
  CLIENT_ROOM_INVITE,
  CLIENT_ROOM_INVITE_ACCEPT,
  CLIENT_ROOM_INVITE_REJECT,
  CLIENT_ROOM_JOIN,
  CLIENT_ROOM_KICK,
  CLIENT_ROOM_LEAVE,
  CLIENT_ROOM_MUTE,
  CLIENT_ROOM_QUICK_PLAY,
  CLIENT_ROOM_READY,
  CLIENT_ROOM_REPORT,
  CLIENT_ROOM_SETTINGS,
  CLIENT_ROOM_TRANSFER_HOST,
  CLIENT_ROOM_VOTE_KICK,
  SERVER_DRAW_SNAPSHOT,
  SERVER_ROOM_CLOSED,
  SERVER_VOICE_STATE,
  ROOM_EVENTS,
  roomChannel,
} from '@/constants/socket.constants';
import { parsePayload } from '@/middleware/validation.middleware';
import {
  invitationTargetSchema,
  inviteToRoomSchema,
  joinRoomSchema,
  muteSchema,
  playerTargetSchema,
  readySchema,
  reportSchema,
  roomSettingsSchema,
  updateSettingsSchema,
} from '@/validators/room.validator';
import { chatService } from '@/services/chat.service';
import { drawingService } from '@/services/drawing.service';
import { gameService } from '@/services/game.service';
import { invitationService } from '@/services/invitation.service';
import { matchmakingService } from '@/services/matchmaking.service';
import { moderationService } from '@/services/moderation.service';
import { presenceService } from '@/services/presence.service';
import { roomService, defaultSettings } from '@/services/room.service';
import { voiceService } from '@/services/voice.service';
import { on, type HandlerContext } from '@/socket/handler';
import { syncSocketProfile } from '@/socket/profile.sync';
import type { GameSocket, RuntimeRoom } from '@/types/socket.types';
import { errors } from '@/utils/errors';

/**
 * Room membership and moderation over the socket (brief sections 15, 40 to 45).
 *
 * Every handler here is a thin shell: validate the payload, call a service,
 * broadcast the result. The rules live in the services so that the REST layer
 * and this one cannot drift apart.
 */

/**
 * Seats a socket in a room's channel and sends it everything it needs.
 *
 * This is the single path into a room, used by create, join and reconnect
 * alike, which is what makes a reconnect indistinguishable from a fresh join
 * as far as the client is concerned (brief section 38): room state, game state
 * and the current board all arrive the same way.
 */
async function enterRoom(socket: GameSocket, room: RuntimeRoom): Promise<void> {
  socket.join(roomChannel(room.roomId));
  socket.data.roomId = room.roomId;

  presenceService.attach(room, socket.data.user.id, socket.id);

  // This arrival may be the one that puts a paused match back at strength.
  // Done before the broadcast below so the newcomer's very first state already
  // says the game is resuming, rather than showing them a waiting screen that
  // is corrected a moment later.
  await gameService.resumeIfPossible(room);

  await gameService.broadcastState(room);

  // The board as it stands, so a late joiner or a returning player sees the
  // drawing already in progress rather than a blank canvas.
  socket.emit(SERVER_DRAW_SNAPSHOT, { strokes: drawingService.snapshot(room) });

  // And whether they may speak. Somebody who joins mid-turn is a guesser and
  // should be in voice immediately rather than waiting for the next round.
  socket.emit(SERVER_VOICE_STATE, voiceService.stateFor(room, socket.data.user.id));
}

/** Removes a socket from a room, closing the room if it empties. */
async function exitRoom(context: HandlerContext, announce: boolean): Promise<void> {
  const { socket, room, userId } = context;
  const player = room.players.get(userId);

  socket.leave(roomChannel(room.roomId));
  socket.data.roomId = null;

  const { roomEmpty } = await roomService.removePlayer(room, userId);
  await removeUserFromRoomChannel(userId, room.roomId);

  if (announce && player) await chatService.presence(room, `${player.username} left.`, false);

  if (roomEmpty) {
    emitToRoom(room.roomId, SERVER_ROOM_CLOSED, { reason: 'Everybody left.' });
    await roomService.close(room, 'last player left');
    return;
  }

  await gameService.onPlayerLeft(room, userId);
  await gameService.broadcastState(room);
}

export function registerRoomHandlers(socket: GameSocket): void {
  // ------------------------------------------------------------------ create

  on(
    socket,
    CLIENT_ROOM_CREATE,
    async ({ socket: sock }, payload) => {
      const body = (payload ?? {}) as { settings?: unknown };
      const settings = body.settings
        ? roomSettingsSchema.parse(body.settings)
        : defaultSettings();

      // Before the seat is cut, not after: `createRoom` stamps the host's seat
      // from `socket.data.user`, so the name and avatar the device is showing
      // have to be on the row by now or the lobby renders the placeholder the
      // account was created with.
      await syncSocketProfile(sock, payload);

      // A socket can only be in one room, so creating a second one leaves the
      // first rather than silently seating the player in two.
      await leaveCurrentRoom(sock);

      const room = await roomService.createRoom({ owner: sock.data.user, settings });
      await enterRoom(sock, room);

      return { room: roomService.serializeRoom(room) };
    },
    { limit: 'createRoom' },
  );

  // -------------------------------------------------------------------- join

  on(
    socket,
    CLIENT_ROOM_JOIN,
    async ({ socket: sock }, payload) => {
      const body = parsePayload(payload, joinRoomSchema);
      const code = body.roomCode ?? body.code ?? '';

      // `resolveByCode` rather than `getByCode`: a room created by the REST
      // process, or one that outlived a restart, is live and joinable but not
      // in this process's registry yet. An unknown or closed code still comes
      // back null and still produces the same refusal.
      const room = await roomService.resolveByCode(code);
      if (!room) throw errors.roomNotFound();

      // Same reason as create, plus one: the presence line below quotes the
      // username, and announcing "Player joined." to a room is exactly the
      // symptom this sync exists to remove.
      await syncSocketProfile(sock, payload);

      await leaveCurrentRoom(sock, room.roomId);

      const { rejoined } = await roomService.joinRoom({ room, user: sock.data.user });
      await enterRoom(sock, room);

      if (!rejoined) {
        await chatService.presence(room, `${sock.data.user.username} joined.`, true);
      }

      return { room: roomService.serializeRoom(room) };
    },
    { limit: 'joinRoom' },
  );

  // -------------------------------------------------------------- quick play

  /**
   * Quick Play.
   *
   * The same three-step shape as join — match, seat, enter — with the matching
   * delegated to `matchmakingService`, which is also what the REST endpoint
   * calls. There is no second engine and no second room shape here: what comes
   * back is an ordinary public room that anybody can later join by its code.
   *
   * Matchmaking reads the live registry, which is why this exists as a socket
   * event at all: "is there a seat free right now" is only answerable in the
   * process holding the rooms, and the seat it produces has to be a socket
   * seat.
   */
  on(
    socket,
    CLIENT_ROOM_QUICK_PLAY,
    async ({ socket: sock }, payload) => {
      // Before matchmaking: the seat is cut from `socket.data.user`, and the
      // presence line below quotes the username.
      await syncSocketProfile(sock, payload);

      const outcome = await matchmakingService.quickPlay(sock.data.user);

      // Already in this very room — a second tap, or a player who reached the
      // button from inside a game. Re-enter for a fresh snapshot, but announce
      // nothing and do not leave first: they never went anywhere.
      const wasHere = sock.data.roomId === outcome.room.roomId;
      if (!wasHere) await leaveCurrentRoom(sock, outcome.room.roomId);

      await enterRoom(sock, outcome.room);

      if (!outcome.alreadySeated) {
        await chatService.presence(outcome.room, `${sock.data.user.username} joined.`, true);
      }

      return {
        room: roomService.serializeRoom(outcome.room),
        created: outcome.created,
        alreadySeated: outcome.alreadySeated,
      };
    },
    { limit: 'quickPlay' },
  );

  // ------------------------------------------------------------------- leave

  on(
    socket,
    CLIENT_ROOM_LEAVE,
    async (context) => {
      await exitRoom(context, true);
    },
    { limit: 'action', requiresRoom: true },
  );

  // ------------------------------------------------------------------- ready

  on(
    socket,
    CLIENT_ROOM_READY,
    async ({ room, userId }, payload) => {
      const { ready } = parsePayload(payload, readySchema);
      await roomService.setReady(room, userId, ready);
      await gameService.broadcastState(room);
    },
    { limit: 'action', requiresRoom: true },
  );

  // ---------------------------------------------------------------- settings

  on(
    socket,
    CLIENT_ROOM_SETTINGS,
    async ({ room, userId }, payload) => {
      const { settings } = parsePayload(payload, updateSettingsSchema);
      await roomService.updateSettings({ room, userId, settings });
      await gameService.broadcastState(room);
    },
    { limit: 'action', requiresRoom: true },
  );

  // ------------------------------------------------------------- invitations

  /**
   * Invites a friend to the room this socket is sitting in.
   *
   * `requiresRoom` is what makes the room implicit: an inviter is by
   * definition somebody in a lobby, and taking the room from the connection
   * rather than from the payload removes the only field a caller could use to
   * invite somebody into a room they are not in. The REST endpoint has to name
   * the room in its path and therefore re-checks membership; here the socket
   * has already answered that question.
   */
  on(
    socket,
    CLIENT_ROOM_INVITE,
    async ({ room, socket: sock }, payload) => {
      const { inviteeId } = parsePayload(payload, inviteToRoomSchema);

      const invitation = await invitationService.invite({
        room,
        inviter: sock.data.user,
        inviteeId,
      });

      return { invitation };
    },
    { limit: 'roomInvite', requiresRoom: true, errorEvent: ROOM_EVENTS.error.alias },
  );

  /**
   * Accepts an invitation and enters the room, in one round trip.
   *
   * The reason this exists beside the REST accept: REST can seat an *account*
   * but not a *connection*, so a player accepting over REST is in the room
   * without their socket being in its channel, and sees nothing until their
   * next `c:room:join`. Here the seat and the channel are taken together, so
   * the ack that says "you are in" is true of the socket as well.
   *
   * The existing room is left first, exactly as `c:room:join` does — and for
   * the same reason: one connection, one room.
   */
  on(
    socket,
    CLIENT_ROOM_INVITE_ACCEPT,
    async ({ socket: sock }, payload) => {
      const { invitationId } = parsePayload(payload, invitationTargetSchema);

      // Before the seat is cut, so the lobby shows the name this device is
      // showing rather than the one the account was created with.
      await syncSocketProfile(sock, payload);
      await leaveCurrentRoom(sock);

      const { room, rejoined } = await invitationService.accept(
        sock.data.user,
        invitationId,
      );

      await enterRoom(sock, room);

      if (!rejoined) {
        await chatService.presence(room, `${sock.data.user.username} joined.`, true);
      }

      return { room: roomService.serializeRoom(room) };
    },
    { limit: 'joinRoom', errorEvent: ROOM_EVENTS.error.alias },
  );

  /** Declines an invitation. Needs no room: the invitee is not in one. */
  on(
    socket,
    CLIENT_ROOM_INVITE_REJECT,
    async ({ socket: sock }, payload) => {
      const { invitationId } = parsePayload(payload, invitationTargetSchema);
      await invitationService.reject(sock.data.user, invitationId);
      return { rejected: true };
    },
    { limit: 'action', errorEvent: ROOM_EVENTS.error.alias },
  );

  // -------------------------------------------------------------- moderation

  on(
    socket,
    CLIENT_ROOM_KICK,
    async ({ room, userId }, payload) => {
      const { playerId } = parsePayload(payload, playerTargetSchema);
      await moderationService.kick({ room, actorId: userId, targetId: playerId });
    },
    { limit: 'moderation', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_ROOM_BAN,
    async ({ room, userId }, payload) => {
      const { playerId } = parsePayload(payload, playerTargetSchema);
      await moderationService.kick({ room, actorId: userId, targetId: playerId, banned: true });
    },
    { limit: 'moderation', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_ROOM_MUTE,
    async ({ room, userId }, payload) => {
      const { playerId, muted } = parsePayload(payload, muteSchema);
      await roomService.setMuted(room, userId, playerId, muted);
      await gameService.broadcastState(room);
    },
    { limit: 'moderation', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_ROOM_TRANSFER_HOST,
    async ({ room, userId }, payload) => {
      const { playerId } = parsePayload(payload, playerTargetSchema);
      await roomService.transferHost(room, userId, playerId);
      await gameService.broadcastState(room);
    },
    { limit: 'moderation', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_ROOM_VOTE_KICK,
    async ({ room, userId }, payload) => {
      const { playerId } = parsePayload(payload, playerTargetSchema);
      const outcome = await moderationService.voteKick({
        room,
        voterId: userId,
        targetId: playerId,
      });
      return outcome;
    },
    { limit: 'voteKick', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_ROOM_REPORT,
    async ({ room, userId }, payload) => {
      const { playerId, reason } = parsePayload(payload, reportSchema);
      await moderationService.report({
        room,
        reporterId: userId,
        targetId: playerId,
        reason,
      });
    },
    { limit: 'report', requiresRoom: true },
  );
}

/**
 * Leaves whatever room this player currently holds a seat in, if any.
 *
 * ## Why it looks at the registry and not only at `socket.data.roomId`
 *
 * That field is what *this connection* last entered, and it is usually the
 * whole story. It is not always: a player who joined over REST has a seat and
 * no socket room, and a second device that entered a different room leaves
 * this one pointing at a room its owner has moved on from. In both cases the
 * seat is real and invisible to a check that only reads the socket.
 *
 * So the seat is looked up where seats actually live. That is what makes the
 * brief's "a user cannot join multiple active game rooms at the same time"
 * true by construction on the socket path, rather than true only when the
 * client behaved. The REST paths refuse outright instead of evicting, because
 * there is no connection there whose intent could be read as "move me".
 */
async function leaveCurrentRoom(socket: GameSocket, keepRoomId?: string): Promise<void> {
  const userId = socket.data.user.id;
  const roomId = socket.data.roomId;

  if (roomId && roomId !== keepRoomId) {
    socket.leave(roomChannel(roomId));
    socket.data.roomId = null;
  }

  const room = (roomId ? roomService.get(roomId) : null) ?? roomService.liveRoomOf(userId);
  if (!room) return;

  // The seat is already in the room this socket is about to enter. That is the
  // ordinary shape of a REST join followed by a socket one — accepting an
  // invitation over REST seats the account, and the connection then enters the
  // same room — and giving the seat up only to take it again would announce a
  // departure that never happened, hand the host role away, and close the room
  // outright if this player were the only one left in it.
  if (room.roomId === keepRoomId) return;

  // The seat may be held on another of this player's connections, so those are
  // taken out of the channel too rather than left listening to a room their
  // owner is no longer in.
  await removeUserFromRoomChannel(userId, room.roomId);

  const { roomEmpty } = await roomService.removePlayer(room, userId);
  if (roomEmpty) {
    await roomService.close(room, 'last player left');
    return;
  }

  await gameService.onPlayerLeft(room, userId);
  await gameService.broadcastState(room);
}

export { enterRoom };
