import { emitToUser } from '@/config/socket';
import { MIN_PLAYERS_TO_START } from '@/constants/game.constants';
import { NOTIFICATION_TYPE } from '@/constants/notification.constants';
import { PROGRESSION_EVENTS } from '@/constants/socket.constants';
import { friendRepository } from '@/repositories/friend.repository';
import { progressionRepository } from '@/repositories/progression.repository';
import { achievementService } from '@/services/achievement.service';
import { notificationService } from '@/services/notification.service';
import { userRepository } from '@/repositories/user.repository';
import { describeLevel, xpService, type XpAward } from '@/services/xp.service';
import type { MatchProgressionDto } from '@/types/progression.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { logger } from '@/utils/logger';

/**
 * What a finished match does to everybody's progression.
 *
 * ## Why this exists rather than calls spread through the game engine
 *
 * The engine already knows how to end a match; it should not also have to know
 * the XP table, the achievement catalogue, the order counters must be written
 * in, or which of those failures are fatal. `game.service.ts` makes one call,
 * and everything in this file is the answer to "and then what".
 *
 * ## The order of writes, and why it is this order
 *
 * 1. **Counters first.** Achievements are evaluated against the stored row, so
 *    the row has to be current before anything reads it. Doing this second
 *    would evaluate against the previous match's numbers.
 * 2. **Streak second.** It is a counter like the others but cannot be batched
 *    with them — a loss *resets* rather than increments — and `bestWinStreak`
 *    has to be raised before the streak achievement looks at it.
 * 3. **XP third.** Independent of the achievements, so it can be paid before
 *    them; doing so means the level in the result already includes match XP
 *    when an achievement's own reward is added on top.
 * 4. **Achievements last**, because they read everything above.
 *
 * ## Nothing here can fail a match
 *
 * Every path is wrapped. A match that ended, ended: its standings are written,
 * its result is broadcast, and a progression failure costs a player some XP
 * they can be granted later — never the game they just played. This is the
 * same argument `notification.service.ts` makes one layer down.
 */

/**
 * Whether a match counts.
 *
 * The brief asks that abandoned or invalid games pay nothing. Most of that is
 * true by construction — the tally lives on the runtime seat and dies with the
 * room, so a match that never reaches `endGame` never reaches this file. What
 * is left is the match that *did* end but should not count: one that never had
 * enough players to be a game, or one where nothing was drawn at all.
 *
 * A player who left before the end is a different case and deliberately still
 * paid: they played the turns they played, and the seat is gone from
 * `room.players` anyway, so they are simply not in the standings.
 */
function isRankedMatch(room: RuntimeRoom, standingsCount: number): boolean {
  if (standingsCount < MIN_PLAYERS_TO_START) return false;
  // `turnNumber` counts turns actually begun. Zero means the match ended
  // before anybody drew — a host starting and immediately aborting.
  if (room.turnNumber <= 0) return false;
  return true;
}

export interface MatchStanding {
  playerId: string;
  score: number;
  /** Rank 1, including ties. */
  won: boolean;
}

export class ProgressionService {
  /**
   * Folds one finished match into everybody's progression.
   *
   * Returns a report per player for the result screen. Players are processed
   * in parallel — they touch disjoint rows — but each player's own writes are
   * sequential, because they depend on each other in the order set out above.
   */
  async recordMatch(input: {
    room: RuntimeRoom;
    standings: MatchStanding[];
    gameId: string | null;
  }): Promise<MatchProgressionDto[]> {
    const { room, standings, gameId } = input;

    if (!isRankedMatch(room, standings.length)) {
      logger.info('match not ranked for progression', {
        roomId: room.roomId,
        players: standings.length,
        turns: room.turnNumber,
      });
      return [];
    }

    // Who in this room is a friend of whom, for the `playedWithFriend` award.
    // One query for the whole room rather than one per player per opponent.
    const friendsInRoom = await this.friendPairs(standings.map((entry) => entry.playerId));

    const reports = await Promise.all(
      standings.map((standing) =>
        this.recordPlayer({
          room,
          standing,
          gameId,
          playedWithFriend: (friendsInRoom.get(standing.playerId)?.size ?? 0) > 0,
        }).catch((error: unknown) => {
          // One player's progression failing must not cost everybody else's.
          logger.exception('progression failed for player', error, {
            roomId: room.roomId,
            userId: standing.playerId,
          });
          return null;
        }),
      ),
    );

    return reports.filter((report): report is MatchProgressionDto => report !== null);
  }

  /** One player's counters, streak, XP and achievements, in that order. */
  private async recordPlayer(input: {
    room: RuntimeRoom;
    standing: MatchStanding;
    gameId: string | null;
    playedWithFriend: boolean;
  }): Promise<MatchProgressionDto | null> {
    const { room, standing, gameId, playedWithFriend } = input;

    const player = room.players.get(standing.playerId);
    // The seat is gone — they left before the final whistle. Their lifetime
    // stats were still recorded by the engine; there is no tally to fold.
    if (!player) return null;

    const tally = player.matchStats;

    // 1. Counters.
    await progressionRepository.addCounters(standing.playerId, {
      correctGuesses: tally.correctGuesses,
      firstGuesses: tally.firstGuesses,
      fastGuesses: tally.fastGuesses,
      perfectDrawings: tally.perfectDrawings,
      drawingTurns: tally.drawingTurns,
    });

    // 2. Streak.
    await progressionRepository.recordStreak(standing.playerId, standing.won);

    // 3. XP.
    const awards: XpAward[] = [
      { reason: 'participated', count: 1 },
      { reason: 'correctGuess', count: tally.correctGuesses },
      { reason: 'firstCorrectGuess', count: tally.firstGuesses },
      { reason: 'drawingCompleted', count: tally.drawingTurns },
      { reason: 'perfectDrawing', count: tally.perfectDrawings },
    ];

    if (standing.won) awards.push({ reason: 'wonGame', count: 1 });
    if (playedWithFriend) awards.push({ reason: 'playedWithFriend', count: 1 });

    const outcome = await xpService.award({
      userId: standing.playerId,
      awards,
      gameId,
    });

    // 4. Achievements. Evaluated after the counters and the XP, so an unlock
    // sees this match's numbers and its reward lands on top of this match's
    // level rather than under it.
    const unlocked = await achievementService.evaluate({
      userId: standing.playerId,
      gameId,
    });

    // The level is re-read once achievements have unlocked, because their
    // rewards are XP too: reporting the level from step 3 would tell a player
    // they are level 9 on the very screen that awarded them level 10's XP.
    const levelBefore = outcome?.level ?? describeLevel(await this.currentXp(standing.playerId));

    const level =
      unlocked.length > 0
        ? describeLevel(await this.currentXp(standing.playerId))
        : levelBefore;

    // Either the match XP crossed a boundary, or an achievement's reward did.
    const leveledUp =
      outcome?.leveledUp === true || level.level > levelBefore.level;

    if (leveledUp) {
      this.announceLevelUp(standing.playerId, level.level, level.title);
    }

    return {
      playerId: standing.playerId,
      xpEarned:
        (outcome?.earned ?? 0) + unlocked.reduce((sum, entry) => sum + entry.xpReward, 0),
      level,
      leveledUp,
      unlocked,
    };
  }

  /**
   * The player's XP as the row holds it right now.
   *
   * A read rather than arithmetic on what was just awarded. The match XP and
   * each achievement reward are written by separate calls, and summing them
   * locally would produce a third number free to disagree with the row — which
   * is the number the profile screen will show a moment later.
   */
  private async currentXp(userId: string): Promise<number> {
    try {
      const user = await userRepository.findById(userId);
      return user?.xp ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Tells a player they levelled up, on every device and durably.
   *
   * The socket event is for the animation — it has to land while the result
   * screen is still on screen — and the notification is what a player who was
   * backgrounded finds later. Same division as everywhere else: the push is
   * the optimisation, the row is the record.
   */
  private announceLevelUp(userId: string, level: number, title: string): void {
    try {
      const payload = { level, title, atMs: Date.now() };
      emitToUser(userId, PROGRESSION_EVENTS.levelUp.canonical, payload);
      emitToUser(userId, PROGRESSION_EVENTS.levelUp.alias, payload);
    } catch (error) {
      logger.exception('level-up push failed', error, { userId, level });
    }

    void notificationService.notify({
      userId,
      type: NOTIFICATION_TYPE.gameResult,
      title: `Level ${level}`,
      body: `You reached level ${level} — ${title}.`,
      data: { level, title },
    });
  }

  /**
   * Which of [playerIds] are friends with each other.
   *
   * One friend-list read per player rather than a pairwise check, which would
   * be `n²` calls for a twelve-seat room. The result is only used as "does
   * this player have at least one friend here", so the sets are intersected
   * against the room roster rather than returned whole.
   */
  private async friendPairs(playerIds: string[]): Promise<Map<string, Set<string>>> {
    const roster = new Set(playerIds);
    const pairs = new Map<string, Set<string>>();

    await Promise.all(
      playerIds.map(async (playerId) => {
        try {
          const friends = await friendRepository.friendIdsOf(playerId);
          pairs.set(playerId, new Set(friends.filter((id) => roster.has(id) && id !== playerId)));
        } catch {
          // A failed read costs one player an XP bonus, never the match.
          pairs.set(playerId, new Set());
        }
      }),
    );

    return pairs;
  }
}

export const progressionService = new ProgressionService();
