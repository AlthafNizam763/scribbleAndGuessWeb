import { NOTIFICATION_TYPE } from '@/constants/notification.constants';
import {
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_KEY,
  type AchievementDefinition,
  type AchievementMetric,
} from '@/constants/progression.constants';
import { friendRepository } from '@/repositories/friend.repository';
import { progressionRepository } from '@/repositories/progression.repository';
import { userRepository } from '@/repositories/user.repository';
import { notificationService } from '@/services/notification.service';
import { xpService } from '@/services/xp.service';
import type { AchievementDto, AchievementsPageDto } from '@/types/progression.types';
import { logger } from '@/utils/logger';

/**
 * Achievements (brief section: Achievements and Badges).
 *
 * ## One evaluator, not twelve predicates
 *
 * Every achievement in the catalogue is "a counter reached a threshold", so
 * there is one function that compares counters to thresholds and nothing
 * achievement-specific anywhere else. Twelve bespoke predicates would be twelve
 * places to forget idempotence, and the one that forgot would pay twice.
 *
 * ## Why re-evaluating is safe
 *
 * The counters this reads only ever increase, so a threshold once crossed
 * stays crossed and evaluation is naturally idempotent: running it twice
 * produces the same set of *deserved* achievements. What stops the second run
 * paying again is the unique index on `achievements` — `unlock` returns false
 * for a row that already existed, and only a true unlock pays XP and notifies.
 *
 * That pair — monotonic counters plus a unique index — is the whole of
 * "prevent duplicate achievement rewards". Neither half is sufficient alone: a
 * read-then-write check loses races, and an index without monotonic counters
 * would let an achievement be legitimately lost and re-earned.
 *
 * ## Why the counters are read rather than passed in
 *
 * The caller has just written them, and could pass what it wrote. It does not,
 * because the authority is the row: another device may have finished a match
 * in the same moment, and the value that matters is the one Mongo holds after
 * both increments. Reading it back is one query per player per match, on a
 * path that already does several.
 */

/** The counters the catalogue watches, gathered for one player. */
export interface MetricSnapshot {
  gamesPlayed: number;
  gamesWon: number;
  correctGuesses: number;
  firstGuesses: number;
  fastGuesses: number;
  perfectDrawings: number;
  bestWinStreak: number;
  bestRoundScore: number;
  friendCount: number;
  dailyChallengesCompleted: number;
  tournamentsWon: number;
}

const EMPTY_SNAPSHOT: MetricSnapshot = {
  gamesPlayed: 0,
  gamesWon: 0,
  correctGuesses: 0,
  firstGuesses: 0,
  fastGuesses: 0,
  perfectDrawings: 0,
  bestWinStreak: 0,
  bestRoundScore: 0,
  friendCount: 0,
  dailyChallengesCompleted: 0,
  tournamentsWon: 0,
};

function valueOf(snapshot: MetricSnapshot, metric: AchievementMetric): number {
  return snapshot[metric] ?? 0;
}

/** Builds the client's view of one catalogue entry. */
function toDto(
  definition: AchievementDefinition,
  snapshot: MetricSnapshot,
  unlockedAtMs: number | null,
): AchievementDto {
  const progress = valueOf(snapshot, definition.metric);

  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    xpReward: definition.xpReward,
    unlocked: unlockedAtMs !== null,
    unlockedAtMs,
    // Clamped so a locked card never reads "112 / 100" after the threshold was
    // crossed but the unlock row has not been written yet.
    progress: Math.min(progress, definition.threshold),
    target: definition.threshold,
    showProgress: definition.showProgress,
  };
}

export class AchievementService {
  /**
   * Reads every counter the catalogue watches, for one player.
   *
   * `friendCount` comes from its own collection rather than a denormalised
   * field on the user, because friendships are one row per pair and a stored
   * count would be a third number able to disagree with them. It is one
   * indexed count on a path that runs once per match, not per guess.
   */
  async snapshot(userId: string): Promise<MetricSnapshot> {
    const [user, friendCount] = await Promise.all([
      userRepository.findById(userId),
      friendRepository.countFriends(userId).catch(() => 0),
    ]);

    if (!user) return { ...EMPTY_SNAPSHOT };

    return {
      gamesPlayed: user.gamesPlayed ?? 0,
      gamesWon: user.gamesWon ?? 0,
      correctGuesses: user.correctGuesses ?? 0,
      firstGuesses: user.firstGuesses ?? 0,
      fastGuesses: user.fastGuesses ?? 0,
      perfectDrawings: user.perfectDrawings ?? 0,
      bestWinStreak: user.bestWinStreak ?? 0,
      bestRoundScore: user.bestRoundScore ?? 0,
      friendCount,
      dailyChallengesCompleted: user.dailyChallengesCompleted ?? 0,
      tournamentsWon: user.tournamentsWon ?? 0,
    };
  }

  /**
   * Unlocks everything [userId] now deserves and has not already got.
   *
   * Returns only what it *newly* unlocked, so the caller can announce exactly
   * those and nothing else. Safe to call at any time and as often as liked —
   * see the note on idempotence in the file header.
   *
   * Each unlock pays its XP through `xpService.awardFixed` *after* the row is
   * written, and only when the write reported a genuine insert. Paying first
   * would mean a duplicate-key loser had already been paid.
   */
  async evaluate(input: {
    userId: string;
    snapshot?: MetricSnapshot;
    gameId?: string | null;
    /** Skips the notification, for callers that batch their own. */
    silent?: boolean;
  }): Promise<AchievementDto[]> {
    const snapshot = input.snapshot ?? (await this.snapshot(input.userId));

    const already = await progressionRepository.unlockedKeys(input.userId);

    const deserved = ACHIEVEMENTS.filter(
      (entry) =>
        !already.has(entry.key) && valueOf(snapshot, entry.metric) >= entry.threshold,
    );

    if (deserved.length === 0) return [];

    const unlocked: AchievementDto[] = [];

    for (const definition of deserved) {
      try {
        const isNew = await progressionRepository.unlock({
          userId: input.userId,
          key: definition.key,
          valueAtUnlock: valueOf(snapshot, definition.metric),
          xpAwarded: definition.xpReward,
        });

        // Lost the race to another evaluation. That one pays and announces.
        if (!isNew) continue;

        await xpService.awardFixed({
          userId: input.userId,
          reason: `achievement:${definition.key}`,
          amount: definition.xpReward,
          gameId: input.gameId ?? null,
        });

        unlocked.push(toDto(definition, snapshot, Date.now()));

        if (!input.silent) {
          void notificationService.notify({
            userId: input.userId,
            type: NOTIFICATION_TYPE.achievementUnlocked,
            title: 'Achievement unlocked',
            body: `${definition.name} — ${definition.description}`,
            data: { achievementKey: definition.key, xpReward: definition.xpReward },
          });
        }

        logger.info('achievement unlocked', {
          userId: input.userId,
          key: definition.key,
          value: valueOf(snapshot, definition.metric),
        });
      } catch (error) {
        // One achievement failing must not abandon the rest, and must never
        // fail the match that triggered the evaluation.
        logger.exception('achievement unlock failed', error, {
          userId: input.userId,
          key: definition.key,
        });
      }
    }

    return unlocked;
  }

  /**
   * The whole catalogue for one player, locked and unlocked together.
   *
   * Locked entries are returned rather than omitted because the screen is a
   * list of things to aim at, not only a trophy case — a player who has
   * unlocked nothing should still see twelve cards with progress on them.
   */
  async listFor(userId: string): Promise<AchievementsPageDto> {
    const [snapshot, rows] = await Promise.all([
      this.snapshot(userId),
      progressionRepository.listUnlocked(userId),
    ]);

    const unlockedAt = new Map<string, number>(
      rows.map((row) => [
        String(row.key),
        ((row as { createdAt?: Date }).createdAt ?? new Date()).getTime(),
      ]),
    );

    const items = ACHIEVEMENTS.map((definition) =>
      toDto(definition, snapshot, unlockedAt.get(definition.key) ?? null),
    );

    return {
      items,
      unlockedCount: items.filter((item) => item.unlocked).length,
      totalCount: items.length,
    };
  }

  /** One catalogue entry by key, or null. Used by the notification renderer. */
  definition(key: string): AchievementDefinition | null {
    return ACHIEVEMENTS_BY_KEY.get(key) ?? null;
  }
}

export const achievementService = new AchievementService();
