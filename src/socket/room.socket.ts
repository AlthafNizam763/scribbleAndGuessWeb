import { emitToRoom, removeUserFromRoomChannel } from '@/config/socket';
import {
  CLIENT_ROOM_BAN,
  CLIENT_ROOM_CREATE,
  CLIENT_ROOM_JOIN,
  CLIENT_ROOM_KICK,
  CLIENT_ROOM_LEAVE,
  CLIENT_ROOM_MUTE,
  CLIENT_ROOM_READY,
  CLIENT_ROOM_REPORT,
  CLIENT_ROOM_SETTINGS,
  CLIENT_ROOM_TRANSFER_HOST,
  CLIENT_ROOM_VOTE_KICK,
  SERVER_DRAW_SNAPSHOT,
  SERVER_ROOM_CLOSED,
  roomChannel,
} from '@/constants/socket.constants';
import { parsePayload } from '@/middleware/validation.middleware';
import {
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
import { moderationService } from '@/services/moderation.service';
import { presenceService } from '@/services/presence.service';
import { roomService, defaultSettings } from '@/services/room.service';
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

      const room = roomService.getByCode(code);
      if (!room) throw errors.roomNotFound();

      // Same reason as create, plus one: the presence line below quotes the
      // username, and announcing "Player joined." to a room is exactly the
      // symptom this sync exists to remove.
      await syncSocketProfile(sock, payload);

      await leaveCurrentRoom(sock);

      const { rejoined } = await roomService.joinRoom({ room, user: sock.data.user });
      await enterRoom(sock, room);

      if (!rejoined) {
        await chatService.presence(room, `${sock.data.user.username} joined.`, true);
      }

      return { room: roomService.serializeRoom(room) };
    },
    { limit: 'joinRoom' },
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

/** Leaves whatever room this socket is currently in, if any. */
async function leaveCurrentRoom(socket: GameSocket): Promise<void> {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = roomService.get(roomId);
  socket.leave(roomChannel(roomId));
  socket.data.roomId = null;

  if (!room) return;

  const { roomEmpty } = await roomService.removePlayer(room, socket.data.user.id);
  if (roomEmpty) {
    await roomService.close(room, 'last player left');
    return;
  }

  await gameService.onPlayerLeft(room, socket.data.user.id);
  await gameService.broadcastState(room);
}

export { enterRoom };
