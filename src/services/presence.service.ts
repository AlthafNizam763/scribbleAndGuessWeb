import { TIMING } from '@/constants/game.constants';
import { CONNECTION } from '@/constants/room.constants';
import { SERVER_ROOM_CLOSED } from '@/constants/socket.constants';
import { emitToRoom } from '@/config/socket';
import { roomRepository } from '@/repositories/room.repository';
import { userRepository } from '@/repositories/user.repository';
import { chatService } from '@/services/chat.service';
import { gameService } from '@/services/game.service';
import { roomService } from '@/services/room.service';
import { tournamentStandInService } from '@/services/tournament/standIn.service';
import { timerService } from '@/services/timer.service';
import type { RuntimeRoom } from '@/types/socket.types';
import { logger } from '@/utils/logger';

/**
 * Presence and reconnection (brief sections 37 to 39).
 *
 * ## Presence is a memory concept
 *
 * Who is online right now is `player.socketIds.size > 0`. It changes several
 * times a minute per player, and nothing reads it at that resolution except
 * the players themselves, so it is never written to Mongo on a timer. The
 * database gets a `lastSeenAt` stamp on connect and on disconnect and nothing
 * in between (brief section 37).
 *
 * ## A disconnect is not a departure
 *
 * A player who drops keeps their seat, their score and their correct-guess
 * status for a grace period. Only when that expires are they actually removed.
 * This is what makes a tunnel, a locked phone or a wifi handover survivable
 * instead of costing somebody their game (brief section 38).
 *
 * Multiple sockets per player are handled by counting them: a player with a
 * phone and a tablet open goes offline when the *last* one drops, not the
 * first.
 */

export class PresenceService {
  /** Records a new socket for a player and reports whether they just came online. */
  attach(room: RuntimeRoom, userId: string, socketId: string): { reconnected: boolean } {
    const player = room.players.get(userId);
    if (!player) return { reconnected: false };

    const wasOffline = player.socketIds.size === 0;

    player.socketIds.add(socketId);
    player.connection = CONNECTION.connected;
    player.disconnectDeadline = null;
    player.lastSeenAt = Date.now();
    room.emptySince = null;

    timerService.cancel(room, graceTimerName(userId));

    if (wasOffline) {
      void userRepository.touch(userId);
      // The drawer coming back cancels the turn's own grace period.
      if (room.round && room.round.drawerId === userId && !room.round.ended) {
        gameService.onDrawerReconnected(room);
      }
    }

    return { reconnected: wasOffline };
  }

  /**
   * Drops one socket, and starts the grace period if it was the last.
   *
   * Returns whether the player is now fully offline, so the caller can decide
   * whether to announce it.
   */
  detach(room: RuntimeRoom, userId: string, socketId: string): { wentOffline: boolean } {
    const player = room.players.get(userId);
    if (!player) return { wentOffline: false };

    player.socketIds.delete(socketId);
    player.lastSeenAt = Date.now();

    // Another device is still connected, so nothing has changed for the room.
    if (player.socketIds.size > 0) return { wentOffline: false };

    // A bracket match is less patient than an ordinary room, because a second
    // person is sitting in it waiting and a whole tournament is behind them.
    // See `TIMING.tournamentReconnectGraceMs`.
    const graceMs = room.tournament
      ? TIMING.tournamentReconnectGraceMs
      : TIMING.reconnectGraceMs;

    player.connection = CONNECTION.reconnecting;
    player.disconnectDeadline = Date.now() + graceMs;

    void userRepository.touch(userId);

    if (room.players.size > 0 && [...room.players.values()].every((p) => p.socketIds.size === 0)) {
      room.emptySince = Date.now();
    }

    // The drawer going dark stalls the whole room, so the game engine gets its
    // own, shorter, grace period for that case (brief section 39).
    if (room.round && room.round.drawerId === userId && !room.round.ended) {
      gameService.onDrawerDisconnected(room);
    }

    timerService.schedule(room, graceTimerName(userId), graceMs, () => {
      void this.expire(room, userId).catch((error: unknown) => {
        logger.exception('expiring a disconnected player failed', error, {
          roomId: room.roomId,
          userId,
        });
      });
    });

    return { wentOffline: true };
  }

  /** Removes a player whose grace period ran out. */
  private async expire(room: RuntimeRoom, userId: string): Promise<void> {
    const player = room.players.get(userId);
    if (!player || player.socketIds.size > 0 || room.closed) return;

    player.connection = CONNECTION.disconnected;

    // In a bracket match the seat is taken over rather than emptied, so the
    // opponent gets a game instead of a walkover. The player is out either
    // way; what changes is whether anybody is left to play against.
    //
    // A failure here falls through to the ordinary removal below, which is the
    // behaviour this replaced — the bracket still resolves, via the entry
    // deadline sweep, so a stand-in that could not be seated costs a match its
    // second half rather than costing the tournament its progress.
    if (room.tournament) {
      const replaced = await tournamentStandInService
        .replace({
          room,
          userId,
          username: player.username,
          seatBot: (target, bot) => roomService.seatBot(target, bot),
        })
        .catch((error: unknown) => {
          logger.exception('replacing a disconnected tournament player failed', error, {
            roomId: room.roomId,
            userId,
          });
          return false;
        });

      if (replaced) {
        await chatService.presence(
          room,
          `${player.username} disconnected. A bot is playing their turns.`,
          false,
        );
        await gameService.broadcastState(room);
        return;
      }
    }

    const { roomEmpty } = await roomService.removePlayer(room, userId);
    await chatService.presence(room, `${player.username} left.`, false);

    logger.info('player expired after a disconnect', { roomId: room.roomId, userId });

    if (roomEmpty) {
      emitToRoom(room.roomId, SERVER_ROOM_CLOSED, { reason: 'Everybody left.' });
      await roomService.close(room, 'empty after grace period');
      return;
    }

    await gameService.onPlayerLeft(room, userId);
    await gameService.broadcastState(room);
  }

  /**
   * Closes rooms nobody has been in for a while, and deletes long-dead ones.
   *
   * Without this every abandoned room would sit in memory forever holding a
   * board and a set of timers. Runs on an interval rather than on the last
   * disconnect so a group that all drop together — a shared wifi blip — get
   * the full grace period to come back to a room that still exists.
   */
  async sweep(): Promise<{ closed: number; deleted: number }> {
    const now = Date.now();
    let closed = 0;

    for (const room of roomService.all()) {
      if (room.closed) continue;
      if (room.emptySince === null) continue;
      if (now - room.emptySince < TIMING.emptyRoomTtlMs) continue;

      await roomService.close(room, 'empty');
      closed += 1;
    }

    // Rooms closed a day ago are of no further interest; their games and
    // rounds remain as history.
    let deleted = 0;
    try {
      const cutoff = new Date(now - 24 * 60 * 60 * 1000);
      const stale = await roomRepository.findSweepable(cutoff);
      for (const document of stale) {
        await roomRepository.deleteById(String(document._id));
        deleted += 1;
      }
    } catch (error) {
      logger.exception('sweeping closed rooms failed', error);
    }

    if (closed > 0 || deleted > 0) logger.info('room sweep', { closed, deleted });
    return { closed, deleted };
  }

  /** Starts the periodic sweep. Returns a function that stops it. */
  startSweeper(): () => void {
    const handle = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        logger.exception('room sweep failed', error);
      });
    }, TIMING.sweepIntervalMs);

    handle.unref?.();
    return () => clearInterval(handle);
  }
}

/** Timer name for one player's reconnect grace period. */
function graceTimerName(userId: string): string {
  return `grace:${userId}`;
}

export const presenceService = new PresenceService();
