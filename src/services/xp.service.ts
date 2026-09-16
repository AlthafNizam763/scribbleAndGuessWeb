import {
  MAX_LEVEL,
  XP_AWARDS,
  levelForXp,
  titleForLevel,
  xpForLevel,
  type XpReason,
} from '@/constants/progression.constants';
import { progressionRepository } from '@/repositories/progression.repository';
import type { LevelDto } from '@/types/progression.types';
import { logger } from '@/utils/logger';

/**
 * Experience and levels (brief section: XP and Level System).
 *
 * ## Every award is computed here, from facts the server owns
 *
 * Nothing in this file takes an amount from a caller. A caller names a
 * *reason* and how many times it applied; the amount comes from `XP_AWARDS`,
 * which is a constant. That is the whole of "prevent XP manipulation": there
 * is no code path, socket event or endpoint through which a number chosen
 * elsewhere becomes XP, so a compromised or modified client has nothing to
 * send.
 *
 * ## Why awards are batched per match rather than paid per guess
 *
 * A correct guess is worth XP, and there are a dozen of them a minute in a
 * busy room. Paying each one immediately would mean a database write on the
 * hottest path in the game, for a number nobody reads until the match ends.
 * So the game engine tallies in memory and calls `award` once per player at
 * the end — which is also what makes the "no XP for abandoned games" rule
 * automatic rather than a check: a tally that never reaches the end of a match
 * is simply discarded with the room.
 */

/** One line of a payout: a reason, and how many times it applied. */
export interface XpAward {
  reason: XpReason;
  count: number;
}

/** What an award did to a player's standing. */
export interface XpOutcome {
  earned: number;
  level: LevelDto;
  leveledUp: boolean;
}

/**
 * Describes where [xp] sits on the curve.
 *
 * Pure, and exported because three places need the same answer: the profile,
 * the result screen and the level-up notification. A second implementation of
 * this arithmetic is how a progress bar ends up disagreeing with the number
 * printed beside it.
 */
export function describeLevel(xp: number): LevelDto {
  const safeXp = Math.max(0, Math.floor(xp));
  const level = levelForXp(safeXp);
  const isMaxLevel = level >= MAX_LEVEL;

  const levelStartXp = xpForLevel(level);
  const nextLevelXp = isMaxLevel ? null : xpForLevel(level + 1);

  const xpIntoLevel = Math.max(0, safeXp - levelStartXp);
  const xpForNextLevel = nextLevelXp === null ? null : Math.max(1, nextLevelXp - levelStartXp);

  return {
    level,
    title: titleForLevel(level),
    xp: safeXp,
    levelStartXp,
    nextLevelXp,
    xpIntoLevel,
    xpForNextLevel,
    // A full bar at the cap, rather than a bar stuck near the end forever.
    progress: xpForNextLevel === null ? 1 : Math.min(1, xpIntoLevel / xpForNextLevel),
    isMaxLevel,
  };
}

/** Totals a payout without writing anything. Exported for the tests. */
export function totalOf(awards: XpAward[]): number {
  return awards.reduce((sum, award) => {
    const rate = XP_AWARDS[award.reason] ?? 0;
    return sum + rate * Math.max(0, Math.floor(award.count));
  }, 0);
}

export class XpService {
  /**
   * Pays a batch of awards to one player.
   *
   * One balance write for the whole batch, then one history row per line — so
   * the history can say "40 XP from 4 correct guesses" while the balance moved
   * exactly once. Doing it the other way round, a write per line, would be
   * four round trips to reach the same number.
   *
   * Returns null when nothing was owed, which is the common case for a player
   * who sat out a match having already left.
   */
  async award(input: {
    userId: string;
    awards: XpAward[];
    gameId?: string | null;
  }): Promise<XpOutcome | null> {
    const lines = input.awards.filter((award) => award.count > 0 && XP_AWARDS[award.reason] > 0);
    const total = totalOf(lines);

    if (total <= 0) return null;

    const moved = await progressionRepository.addXp(input.userId, total, levelForXp);
    if (!moved) return null;

    // Logged after the balance moves so `balanceAfter` is a fact rather than a
    // prediction. A failure here costs an unexplained line in the history and
    // never the XP itself — the balance is already written.
    await Promise.all(
      lines.map((line) =>
        progressionRepository
          .logXp({
            userId: input.userId,
            reason: line.reason,
            amount: XP_AWARDS[line.reason] * Math.floor(line.count),
            count: Math.floor(line.count),
            gameId: input.gameId ?? null,
            balanceAfter: moved.after,
          })
          .catch((error: unknown) => {
            logger.exception('xp history write failed', error, {
              userId: input.userId,
              reason: line.reason,
            });
          }),
      ),
    );

    return {
      earned: total,
      level: describeLevel(moved.after),
      leveledUp: moved.levelAfter > moved.levelBefore,
    };
  }

  /**
   * Pays a single fixed amount for something outside the award table.
   *
   * The one legitimate caller is the achievement service, whose rewards are
   * per-achievement rather than per-reason. It is deliberately not general: a
   * caller still cannot choose the number, because the only amounts that reach
   * it come from the catalogue constant.
   */
  async awardFixed(input: {
    userId: string;
    reason: string;
    amount: number;
    gameId?: string | null;
  }): Promise<XpOutcome | null> {
    const amount = Math.max(0, Math.floor(input.amount));
    if (amount <= 0) return null;

    const moved = await progressionRepository.addXp(input.userId, amount, levelForXp);
    if (!moved) return null;

    await progressionRepository
      .logXp({
        userId: input.userId,
        reason: input.reason,
        amount,
        count: 1,
        gameId: input.gameId ?? null,
        balanceAfter: moved.after,
      })
      .catch((error: unknown) => {
        logger.exception('xp history write failed', error, {
          userId: input.userId,
          reason: input.reason,
        });
      });

    return {
      earned: amount,
      level: describeLevel(moved.after),
      leveledUp: moved.levelAfter > moved.levelBefore,
    };
  }
}

export const xpService = new XpService();
