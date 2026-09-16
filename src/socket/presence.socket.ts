import {
  CLIENT_HELLO,
  CLIENT_TIME_PING,
  SERVER_DRAW_SNAPSHOT,
  SERVER_VOICE_STATE,
  roomChannel,
} from '@/constants/socket.constants';
import { parsePayload } from '@/middleware/validation.middleware';
import { metrics } from '@/monitoring/metrics';
import { drawingService } from '@/services/drawing.service';
import { gameService } from '@/services/game.service';
import { presenceService } from '@/services/presence.service';
import { roomService } from '@/services/room.service';
import { voiceService } from '@/services/voice.service';
import { userRepository } from '@/repositories/user.repository';
import { roomRepository } from '@/repositories/room.repository';
import { on } from '@/socket/handler';
import { syncSocketProfile } from '@/socket/profile.sync';
import type { GameSocket, RuntimePlayer } from '@/types/socket.types';
import { timePingSchema } from '@/validators/game.validator';
import { logger } from '@/utils/logger';

/**
 * Handshake, clock sync, reconnection and disconnect (brief sections 14, 37, 38).
 *
 * ## The clock
 *
 * `c:hello` and `c:time:ping` exist so the client can measure the offset
 * between its clock and this one. That measurement is what makes a
 * server-authoritative countdown displayable: the server sends absolute
 * deadlines, and the client subtracts its own drift before rendering. Without
 * it a device with a fast clock would show the wrong seconds remaining
 * (brief section 27).
 *
 * `c:time:ping` acks `{t0, t1}` — the client's send stamp echoed back plus the
 * server's receive stamp — rather than an `{ok: true}` envelope, because the
 * client's `_syncClock` reads those two fields directly.
 *
 * ## Reconnection
 *
 * A reconnecting socket is a brand new connection: Socket.IO does not resume
 * anything for us. So `c:hello` looks for a room this user still holds a seat
 * in and puts them back into it, board and all (brief section 38).
 */
export function registerPresenceHandlers(socket: GameSocket): void {
  // ------------------------------------------------------------------- hello

  on(
    socket,
    CLIENT_HELLO,
    async ({ socket: sock, userId }, payload) => {
      // The profile in the payload is display data only. The identity that
      // matters came from the verified token in the handshake middleware, so
      // only the name and avatar are taken from it and the id it carries is
      // ignored.
      //
      // Awaited, and awaited *before* the seat is restored: the account was
      // created under a placeholder name at app launch, and this is where the
      // device's real one lands. Restoring the seat first would broadcast the
      // placeholder one more time.
      void userRepository.touch(userId);
      await syncSocketProfile(sock, payload);

      const restored = await restoreSeat(sock, userId);

      return {
        serverTimeMs: Date.now(),
        playerId: userId,
        ...(restored ? { roomCode: restored } : {}),
      };
    },
    { limit: 'action' },
  );

  // --------------------------------------------------------------- time ping

  socket.on(CLIENT_TIME_PING, (...args: unknown[]) => {
    const last = args[args.length - 1];
    const ack = typeof last === 'function' ? (last as (response: unknown) => void) : undefined;
    if (!ack) return;

    const payload = args.length > 1 ? args[0] : {};

    try {
      const { t0 } = parsePayload(payload, timePingSchema);
      // No envelope: the client reads `t0` and `t1` straight off this map.
      ack({ t0, t1: Date.now() });
    } catch {
      ack({ t0: 0, t1: Date.now() });
    }
  });

  // -------------------------------------------------------------- disconnect

  socket.on('disconnect', (reason: string) => {
    const roomId = socket.data.roomId;
    const userId = socket.data.user?.id;

    logger.debug('socket disconnected', { userId, reason });

    if (!roomId || !userId) return;

    const room = roomService.get(roomId);
    if (!room) return;

    // Voice, unlike the seat, does not survive the drop. A peer connection to
    // a socket that is gone is dead the moment the socket is, so the group is
    // told now rather than waiting for each remaining peer's ICE to time out
    // on its own. The player rejoins voice when their client reconnects and
    // sees it is still a guesser.
    //
    // Guarded on the socket id so a player on two devices closing one of them
    // does not hang up the other.
    if (room.voice.members.get(userId)?.socketId === socket.id) {
      voiceService.leave(room, userId, 'disconnected');
    }

    // The seat is kept. Only the grace period expiring actually removes them,
    // which is what lets a dropped connection be survivable.
    const { wentOffline } = presenceService.detach(room, userId, socket.id);

    if (wentOffline) {
      void gameService.broadcastState(room).catch((error: unknown) => {
        logger.exception('broadcasting after a disconnect failed', error, { roomId });
      });
    }
  });
}

/**
 * Puts a reconnecting player back into the room they still hold a seat in.
 *
 * Checks memory first, then storage: a room this process forgot — after a
 * restart — is rebuilt from Mongo rather than leaving the player stranded on a
 * lobby screen with a room code that "does not exist".
 *
 * Returns the room code when a seat was restored.
 */
async function restoreSeat(socket: GameSocket, userId: string): Promise<string | null> {
  for (const room of roomService.all()) {
    if (!room.players.has(userId)) continue;
    await seat(socket, room.roomId);
    return room.code;
  }

  const documents = await roomRepository.findLiveForUser(userId);
  const document = documents[0];
  if (!document) return null;

  const room = await roomService.hydrate(String(document._id));
  if (!room?.players.has(userId)) return null;

  await seat(socket, room.roomId);
  return room.code;
}

/** Joins the channel and replays the current state to this socket. */
async function seat(socket: GameSocket, roomId: string): Promise<void> {
  const room = roomService.get(roomId);
  if (!room) return;

  socket.join(roomChannel(roomId));
  socket.data.roomId = roomId;

  // Take the current profile, exactly as `joinRoom` does: a player who renamed
  // themselves between sessions comes back under the new name rather than the
  // one frozen into the seat when they first sat down. Mirrored to storage
  // only when it actually moved — this runs on every reconnect, and a room
  // write per reconnect would be a write for nothing almost every time.
  const seated = room.players.get(socket.data.user.id);
  if (seated && stale(seated, socket)) {
    seated.username = socket.data.user.username;
    seated.avatarId = socket.data.user.avatarId;
    seated.avatarColorIndex = socket.data.user.avatarColorIndex;
    await roomService.persist(room);
  }

  presenceService.attach(room, socket.data.user.id, socket.id);

  // The brief's reconnect count. Incremented here rather than on every socket
  // connection because this is the path that actually *restored* somebody to a
  // seat they still held — a fresh sign-in is a connection, not a reconnect,
  // and conflating the two would make the figure describe app launches.
  metrics.increment('socket.reconnects.restored');

  // A reconnect counts towards the minimum exactly as a fresh join does, so a
  // match paused by this player's departure comes back when they do.
  await gameService.resumeIfPossible(room);

  socket.emit(SERVER_DRAW_SNAPSHOT, { strokes: drawingService.snapshot(room) });
  await gameService.broadcastState(room);

  // Whether this player may speak is decided here, not by their client
  // remembering what it was doing before the drop. A guesser who reconnects as
  // the new drawer gets `enabled: false` and never asks to join; a guesser who
  // is still a guesser gets the peer list and rebuilds its mesh.
  socket.emit(SERVER_VOICE_STATE, voiceService.stateFor(room, socket.data.user.id));

  logger.info('player restored to room', { roomId, userId: socket.data.user.id });
}

/** Whether a seat is showing a name or face the account has since changed. */
function stale(player: RuntimePlayer, socket: GameSocket): boolean {
  const { username, avatarId, avatarColorIndex } = socket.data.user;
  return (
    player.username !== username ||
    player.avatarId !== avatarId ||
    player.avatarColorIndex !== avatarColorIndex
  );
}
