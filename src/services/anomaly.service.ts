import { SCORING } from '@/constants/game.constants';
import { Report } from '@/models/Report';
import { isDuplicateKeyError } from '@/repositories/friend.repository';
import type { RuntimeRoom } from '@/types/socket.types';
import { logger } from '@/utils/logger';

/**
 * Suspicious score detection (brief section: Moderation and Safety).
 *
 * ## What this can and cannot be
 *
 * In this codebase a score is not something a client sends. Points are
 * computed by `scoring.service.ts` from a server clock and a server-owned
 * guess order, and `PATCH /api/users/me` has no field for any of them — so the
 * obvious cheat, a client posting its own total, is already impossible by
 * construction rather than by detection.
 *
 * What is left for a detector is the case where a score is legitimate at every
 * step and implausible in aggregate: a bug in the scoring maths, a mode
 * multiplier applied twice, or a room somebody found a way to farm. That is
 * worth knowing about, and it is worth knowing about *quietly* — none of these
 * are confident enough to act on.
 *
 * ## So it files a report rather than punishing anybody
 *
 * A flag here lands in the same review queue a player's report lands in, and a
 * person decides. Anything automatic would be a system that bans people for
 * playing unusually well, which is a worse failure than missing a cheat.
 */

/**
 * The most one player could earn in one turn, generously.
 *
 * Every bonus at once, at the hardest difficulty, under the most generous mode
 * multiplier — a number nobody reaches in practice. The point is to be so far
 * above legitimate play that crossing it means something is wrong with the
 * *code*, not that somebody had a good game.
 */
const MAX_PLAUSIBLE_TURN_SCORE =
  (SCORING.maxGuessPoints + SCORING.firstGuessBonus) * 1.35 * 1.5 +
  SCORING.drawerMaxPoints;

/** The headroom multiplier applied before anything is flagged. */
const TOLERANCE = 1.25;

export class AnomalyService {
  /**
   * The ceiling a match of this many turns could plausibly produce.
   *
   * Turns rather than rounds, because a player scores on every turn — their
   * own and everybody else's — and a long match legitimately produces a large
   * total.
   */
  plausibleCeiling(turnsPlayed: number): number {
    return Math.ceil(MAX_PLAUSIBLE_TURN_SCORE * Math.max(1, turnsPlayed) * TOLERANCE);
  }

  /**
   * Checks a finished match's standings and flags anything implausible.
   *
   * Never throws and never blocks: it is called after the result has already
   * been written and broadcast, so a failure here costs a flag rather than the
   * match. Returns how many were flagged, for the log.
   */
  async inspectMatch(input: {
    room: RuntimeRoom;
    standings: readonly { playerId: string; name: string; score: number }[];
  }): Promise<number> {
    const { room, standings } = input;

    const ceiling = this.plausibleCeiling(room.turnNumber);
    const suspects = standings.filter((entry) => entry.score > ceiling);

    if (suspects.length === 0) return 0;

    for (const suspect of suspects) {
      logger.warn('implausible match score', {
        roomId: room.roomId,
        gameId: room.gameId,
        userId: suspect.playerId,
        score: suspect.score,
        ceiling,
        turns: room.turnNumber,
      });

      try {
        await Report.create({
          roomId: room.roomId,
          reportedUserId: suspect.playerId,
          // Filed against the room's host, because a report needs a reporter
          // and there is no system account. The reason says plainly that this
          // was automatic, so a reviewer is never misled into thinking a
          // person complained.
          reporterUserId: room.hostId,
          reason: `Automatic: score ${suspect.score} exceeds the plausible ceiling of ${ceiling} for ${room.turnNumber} turns.`,
          gameId: room.gameId,
        });
      } catch (error) {
        // The unique index makes a repeat flag in the same room a no-op, which
        // is the right behaviour: one entry in the queue per room, not one per
        // match replayed in it.
        if (!isDuplicateKeyError(error)) {
          logger.exception('failed to file an anomaly report', error, {
            roomId: room.roomId,
            userId: suspect.playerId,
          });
        }
      }
    }

    return suspects.length;
  }
}

export const anomalyService = new AnomalyService();
