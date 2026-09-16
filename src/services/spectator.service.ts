import { emitToRoom, removeUserFromRoomChannel } from '@/config/socket';
import { roomChannel } from '@/constants/socket.constants';
import { gameModeService } from '@/services/gameMode.service';
import type { GameSocket, RuntimeRoom, RuntimeSpectator } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Watching a room without holding a seat (brief section: Spectator Mode).
 *
 * ## Why a spectator is absent from `players` rather than flagged in it
 *
 * Every rule in the engine iterates `room.players`: the turn order, the
 * minimum-player check, the all-guessed test, scoring, voice membership, the
 * standings. A spectator *flag* would mean auditing every one of those to
 * exclude them — and the one that was missed would be a watcher who could take
 * a turn, or guess, or win.
 *
 * Keeping spectators in their own map makes "cannot draw, cannot guess, cannot
 * score, cannot be the drawer" true **by construction**. There is no check to
 * forget, because there is no seat to exclude.
 *
 * ## What a spectator does get
 *
 * The room channel, so every broadcast reaches them: the board, the state, the
 * scoreboard, the timer. What they do not get is the word — `emitPerViewer`
 * builds game state per recipient and only the drawer's copy carries it, and a
 * spectator is not the drawer in any room.
 */

export class SpectatorService {
  /** Whether this room admits watchers at all. */
  allows(room: RuntimeRoom): boolean {
    return room.settings.allowSpectators;
  }

  /**
   * Whether somebody must watch rather than play.
   *
   * True once the seats are full. The caller decides what to do about it: the
   * join path offers spectating, and a room with spectating switched off
   * refuses outright.
   */
  isFull(room: RuntimeRoom): boolean {
    const active = [...room.players.values()].filter(
      (player) => player.connection !== 'disconnected',
    ).length;

    return active >= gameModeService.seatLimit(room);
  }

  /**
   * Seats somebody in the gallery.
   *
   * Refused when the host has switched spectating off, and when the caller
   * already holds a *seat* — a player watching their own room would be absent
   * from the turn order they are in.
   */
  join(room: RuntimeRoom, socket: GameSocket): RuntimeSpectator {
    const user = socket.data.user;

    if (!this.allows(room)) {
      throw errors.invalidAction('This room is not open to spectators.');
    }
    if (room.players.has(user.id)) {
      throw errors.invalidAction('You already have a seat in this room.');
    }
    if (room.bannedIds.has(user.id)) throw errors.banned();

    const existing = room.spectators.get(user.id);

    if (existing) {
      // A second device, or a reconnect. The seat is the person, not the
      // socket, so the new connection joins the existing entry rather than
      // creating a ghost the room would count twice.
      existing.socketIds.add(socket.id);
    } else {
      room.spectators.set(user.id, {
        userId: user.id,
        username: user.username,
        avatarId: user.avatarId,
        avatarColorIndex: user.avatarColorIndex,
        socketIds: new Set([socket.id]),
        joinedAt: Date.now(),
      });
    }

    void socket.join(roomChannel(room.roomId));
    socket.data.roomId = room.roomId;

    logger.info('spectator joined', { roomId: room.roomId, userId: user.id });

    return room.spectators.get(user.id)!;
  }

  /**
   * Removes one socket from the gallery, and the watcher with it if that was
   * their last.
   *
   * Returns whether the *person* left, which is what a broadcast cares about:
   * closing one of two tabs is not somebody leaving.
   */
  leave(room: RuntimeRoom, userId: string, socketId?: string): boolean {
    const spectator = room.spectators.get(userId);
    if (!spectator) return false;

    if (socketId) spectator.socketIds.delete(socketId);
    else spectator.socketIds.clear();

    if (spectator.socketIds.size > 0) return false;

    room.spectators.delete(userId);
    void removeUserFromRoomChannel(userId, room.roomId);

    logger.info('spectator left', { roomId: room.roomId, userId });
    return true;
  }

  /** The gallery as the wire sees it. */
  serialize(room: RuntimeRoom): {
    userId: string;
    username: string;
    avatarId: number;
    avatarColorIndex: number;
  }[] {
    return [...room.spectators.values()].map((spectator) => ({
      userId: spectator.userId,
      username: spectator.username,
      avatarId: spectator.avatarId,
      avatarColorIndex: spectator.avatarColorIndex,
    }));
  }

  /** Whether this user is watching rather than playing. */
  isSpectating(room: RuntimeRoom, userId: string): boolean {
    return room.spectators.has(userId);
  }

  /**
   * Drops every spectator, telling them why.
   *
   * Used when a host turns spectating off mid-match. The alternative — letting
   * existing watchers stay — would make the setting mean "no *new* spectators",
   * which is not what a host switching it off is asking for.
   */
  clear(room: RuntimeRoom, reason: string): void {
    if (room.spectators.size === 0) return;

    const removed = [...room.spectators.keys()];
    room.spectators.clear();

    for (const userId of removed) {
      void removeUserFromRoomChannel(userId, room.roomId);
    }

    emitToRoom(room.roomId, 's:room:spectatorsCleared', { reason });
    logger.info('spectators cleared', { roomId: room.roomId, count: removed.length, reason });
  }
}

export const spectatorService = new SpectatorService();
