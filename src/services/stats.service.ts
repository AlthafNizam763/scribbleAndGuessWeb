import { ACHIEVEMENTS, levelForXp, titleForLevel } from '@/constants/progression.constants';
import { progressionRepository } from '@/repositories/progression.repository';
import { userRepository } from '@/repositories/user.repository';
import type { PlayerStatsDto } from '@/types/stats.types';
import { errors } from '@/utils/errors';

/**
 * A player's full career record (brief section: Player Statistics).
 *
 * ## Nothing here is stored
 *
 * Every field is either a counter the game engine already maintains or a ratio
 * derived from two of them. There is no `stats` document, no aggregation job
 * and nothing to keep in step — which is the whole reason the numbers cannot
 * drift from the game that produced them.
 *
 * Deriving rather than storing is the same argument `toUserStats` makes for
 * the win rate, applied to the rest: a stored average is a third number that
 * can disagree with the two it comes from, and the only way to keep it honest
 * is to recompute it on every write anyway.
 */

/** A percentage to one decimal place, or 0 when the denominator is zero. */
function rate(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export class StatsService {
  /**
   * The full record for one player.
   *
   * Public: these are the same numbers a leaderboard already shows, in more
   * detail. What is *not* here is anything private — no email, no locality
   * beyond what the profile already publishes, and no XP history, which is an
   * itemised log of when somebody played and stays the caller's own.
   */
  async forUser(userId: string): Promise<PlayerStatsDto> {
    const [user, unlocked] = await Promise.all([
      userRepository.findById(userId),
      progressionRepository.listUnlocked(userId).catch(() => []),
    ]);

    if (!user) throw errors.notFound('That player no longer exists.');

    const played = Math.max(0, user.gamesPlayed ?? 0);
    const won = Math.max(0, user.gamesWon ?? 0);
    const drawn = Math.max(0, user.drawingTurns ?? 0);
    const perfect = Math.max(0, user.perfectDrawings ?? 0);
    const xp = Math.max(0, user.xp ?? 0);
    const level = levelForXp(xp);

    return {
      gamesPlayed: played,
      gamesWon: won,
      // Derived, so it can never disagree with the two numbers above it — and
      // never negative, even if a counter were somehow written out of step.
      gamesLost: Math.max(0, played - won),
      winRate: rate(won, played),

      totalScore: Math.max(0, user.totalScore ?? 0),
      bestRoundScore: Math.max(0, user.bestRoundScore ?? 0),
      averageScore: played === 0 ? 0 : Math.round((user.totalScore ?? 0) / played),

      correctGuesses: Math.max(0, user.correctGuesses ?? 0),
      firstGuesses: Math.max(0, user.firstGuesses ?? 0),
      fastGuesses: Math.max(0, user.fastGuesses ?? 0),

      drawingTurns: drawn,
      perfectDrawings: perfect,
      perfectDrawingRate: rate(perfect, drawn),

      currentWinStreak: Math.max(0, user.currentWinStreak ?? 0),
      bestWinStreak: Math.max(0, user.bestWinStreak ?? 0),

      xp,
      level,
      levelTitle: titleForLevel(level),
      achievementsUnlocked: unlocked.length,
      achievementsTotal: ACHIEVEMENTS.length,

      joinedAtMs: (user.createdAt ?? new Date()).getTime(),
      lastSeenAtMs: (user.lastSeenAt ?? new Date()).getTime(),
    };
  }
}

export const statsService = new StatsService();
