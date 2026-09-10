import { TIMING } from '@/constants/game.constants';
import { SERVER_YOU_KICKED } from '@/constants/socket.constants';
import { emitToUser, removeUserFromRoomChannel } from '@/config/socket';
import { Report } from '@/models/Report';
import { chatService } from '@/services/chat.service';
import { gameService } from '@/services/game.service';
import { roomService } from '@/services/room.service';
import { TIMER, timerService } from '@/services/timer.service';
import type { RuntimeRoom } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Moderation (brief sections 40 to 45).
 *
 * Every action here is authorised server-side. The client draws a kick button
 * next to a player when it believes the local user is the host, but that
 * belief is a rendering decision — the check that matters is
 * `roomService.assertHost`, run here, on every call.
 */

export class ModerationService {
  /**
   * Removes a player from a room (brief section 41).
   *
   * The order matters: tell them first, then unseat them, then drop them from
   * the channel. Reversed, the kicked player would already be out of the room
   * when the notice was sent and would never learn why they were ejected.
   */
  async kick(input: {
    room: RuntimeRoom;
    actorId: string;
    targetId: string;
    banned?: boolean;
  }): Promise<void> {
    const { room, actorId, targetId } = input;

    roomService.assertHost(room, actorId);
    if (targetId === actorId) throw errors.invalidAction('You cannot kick yourself.');

    const target = roomService.assertMember(room, targetId);
    const banned = input.banned ?? false;

    emitToUser(targetId, SERVER_YOU_KICKED, {
      reason: banned ? 'You were banned from this room.' : 'You were removed from this room.',
    });

    if (banned) room.bannedIds.add(targetId);

    const { roomEmpty } = await roomService.removePlayer(room, targetId);
    await removeUserFromRoomChannel(targetId, room.roomId);

    await chatService.presence(
      room,
      `${target.username} was ${banned ? 'banned' : 'removed'}.`,
      false,
    );

    logger.info('player removed by host', {
      roomId: room.roomId,
      actorId,
      targetId,
      banned,
    });

    if (roomEmpty) {
      await roomService.close(room, 'empty after moderation');
      return;
    }

    await gameService.onPlayerLeft(room, targetId);
    await gameService.broadcastState(room);
  }

  /**
   * Opens or advances a vote to kick (brief section 45).
   *
   * One poll at a time per room. Calling this for the player already under
   * a vote counts as a vote for them; calling it for anybody else while a poll
   * is open is refused, so a room cannot be flooded with simultaneous polls.
   *
   * The threshold is a majority of everybody *except* the target, so a player
   * cannot be removed by a minority and cannot save themselves by abstaining.
   */
  async voteKick(input: {
    room: RuntimeRoom;
    voterId: string;
    targetId: string;
  }): Promise<{ votes: number; threshold: number; passed: boolean }> {
    const { room, voterId, targetId } = input;

    if (!room.settings.allowVoteKick) {
      throw errors.invalidAction('Vote-kick is switched off in this room.');
    }
    if (voterId === targetId) throw errors.invalidAction('You cannot vote to kick yourself.');

    roomService.assertMember(room, voterId);
    const target = roomService.assertMember(room, targetId);

    if (targetId === room.hostId) {
      throw errors.invalidAction('The host cannot be vote-kicked.');
    }

    const now = Date.now();
    let poll = room.voteKick;

    // An expired poll is treated as no poll, so a stale one cannot block a
    // fresh vote against somebody else.
    if (poll && (poll.expiresAt <= now || !room.players.has(poll.targetId))) {
      poll = null;
      room.voteKick = null;
      timerService.cancel(room, TIMER.voteKick);
    }

    if (poll && poll.targetId !== targetId) {
      throw errors.invalidAction('There is already a vote in progress.');
    }

    if (!poll) {
      const eligible = Math.max(1, room.players.size - 1);
      poll = {
        targetId,
        voterIds: new Set(),
        threshold: Math.max(2, Math.ceil(eligible / 2)),
        expiresAt: now + TIMING.voteKickWindowMs,
      };
      room.voteKick = poll;

      await chatService.system(
        room,
        `A vote to remove ${target.username} has started.`,
      );

      timerService.schedule(room, TIMER.voteKick, TIMING.voteKickWindowMs, () => {
        if (room.voteKick?.targetId !== targetId) return;
        room.voteKick = null;
        void chatService.system(room, `The vote to remove ${target.username} failed.`);
      });
    }

    // A Set makes a repeat vote a no-op rather than a second tally.
    poll.voterIds.add(voterId);

    const votes = poll.voterIds.size;
    const passed = votes >= poll.threshold;

    if (passed) {
      room.voteKick = null;
      timerService.cancel(room, TIMER.voteKick);

      emitToUser(targetId, SERVER_YOU_KICKED, { reason: 'The room voted to remove you.' });

      const { roomEmpty } = await roomService.removePlayer(room, targetId);
      await removeUserFromRoomChannel(targetId, room.roomId);
      await chatService.presence(room, `${target.username} was voted out.`, false);

      logger.info('vote kick passed', { roomId: room.roomId, targetId, votes });

      if (roomEmpty) {
        await roomService.close(room, 'empty after vote kick');
      } else {
        await gameService.onPlayerLeft(room, targetId);
        await gameService.broadcastState(room);
      }
    } else {
      await chatService.system(
        room,
        `${votes} of ${poll.threshold} votes to remove ${target.username}.`,
      );
    }

    return { votes, threshold: poll.threshold, passed };
  }

  /**
   * Files a report (brief section 44).
   *
   * Nothing is echoed back beyond an acknowledgement, and no route ever reads
   * these rows: a report the reported player could see, or that could be
   * counted publicly, becomes a harassment tool itself.
   *
   * A duplicate report is quietly treated as success — the unique index makes
   * it a no-op, and telling somebody "you already reported them" invites them
   * to find another way.
   */
  async report(input: {
    room: RuntimeRoom;
    reporterId: string;
    targetId: string;
    reason: string;
  }): Promise<void> {
    const { room, reporterId, targetId } = input;

    if (reporterId === targetId) throw errors.invalidAction('You cannot report yourself.');
    roomService.assertMember(room, reporterId);
    roomService.assertMember(room, targetId);

    const reason = input.reason.trim().slice(0, 120);
    if (reason.length === 0) throw errors.validation('Add a reason for the report.');

    try {
      await Report.create({
        roomId: room.roomId,
        reportedUserId: targetId,
        reporterUserId: reporterId,
        reason,
        gameId: room.gameId,
      });
      logger.info('player reported', { roomId: room.roomId, targetId });
    } catch (error) {
      // Code 11000 is the unique index rejecting a repeat report.
      const duplicate =
        typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
      if (!duplicate) throw error;
    }
  }
}

export const moderationService = new ModerationService();
