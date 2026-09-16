import { Types } from 'mongoose';

import { Achievement, type AchievementDocument } from '@/models/Achievement';
import { User } from '@/models/User';
import { XP_EVENT_TTL_MS, XpEvent } from '@/models/XpEvent';
import { isObjectId } from '@/repositories/user.repository';

/**
 * Data access for `achievements`, `xp_events` and the progression counters on
 * `users`.
 *
 * All three live here because they are written together: one finished match
 * increments the counters, may insert an unlock, and logs an award. Splitting
 * them across three repositories would make that sequence look like three
 * unrelated operations, when the only reason any of them happens is the same
 * one event.
 *
 * As everywhere else in this layer there are no rules — *whether* a threshold
 * was crossed is the service's business. What this module owns is that every
 * write is an `$inc`, an `$max` or a guarded insert, never a read-modify-write.
 */

const asId = (value: string): Types.ObjectId => new Types.ObjectId(value);

/** Whether a thrown error is Mongo's duplicate-key error. */
export function isDuplicateAchievement(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

/** The per-match tally folded into a player's lifetime counters. */
export interface ProgressionCounters {
  correctGuesses: number;
  firstGuesses: number;
  fastGuesses: number;
  perfectDrawings: number;
  drawingTurns: number;
}

export const progressionRepository = {
  /**
   * Folds one finished match's counters into a player's totals.
   *
   * `$inc` rather than read-modify-write, for the same reason
   * `recordGameResult` uses it: two matches finishing at once for one player —
   * a phone and a tablet in different rooms — would otherwise race and lose an
   * increment. Zeroes are still sent; incrementing by zero is a no-op and
   * costs less than branching per field.
   */
  async addCounters(userId: string, counters: ProgressionCounters): Promise<void> {
    if (!isObjectId(userId)) return;

    await User.updateOne(
      { _id: asId(userId) },
      {
        $inc: {
          correctGuesses: Math.max(0, counters.correctGuesses),
          firstGuesses: Math.max(0, counters.firstGuesses),
          fastGuesses: Math.max(0, counters.fastGuesses),
          perfectDrawings: Math.max(0, counters.perfectDrawings),
          drawingTurns: Math.max(0, counters.drawingTurns),
        },
      },
    ).exec();
  },

  /**
   * Advances or resets a player's win streak, and raises their best.
   *
   * Two writes rather than one because they are different operations: a win
   * increments and then raises the high-water mark, a loss resets. Expressing
   * a reset as an `$inc` is not possible, and expressing both as a `$set`
   * would reintroduce the read-modify-write race.
   *
   * On a win the `$max` is applied in a second step, once the new streak is
   * known — `$inc` and `$max` cannot see each other's results inside one
   * update, so a single document write cannot say "raise the best to whatever
   * the streak just became".
   */
  async recordStreak(userId: string, won: boolean): Promise<number> {
    if (!isObjectId(userId)) return 0;

    if (!won) {
      await User.updateOne({ _id: asId(userId) }, { $set: { currentWinStreak: 0 } }).exec();
      return 0;
    }

    const updated = await User.findByIdAndUpdate(
      asId(userId),
      { $inc: { currentWinStreak: 1 } },
      { new: true, projection: { currentWinStreak: 1 } },
    )
      .lean()
      .exec();

    const streak = updated?.currentWinStreak ?? 0;

    await User.updateOne({ _id: asId(userId) }, { $max: { bestWinStreak: streak } }).exec();

    return streak;
  },

  /**
   * Adds XP and stores the level it buys.
   *
   * Returns the balance and level both before and after, which is what lets
   * the caller detect a level-up without a second read and without deciding
   * for itself what the old level was. The level is computed by the caller and
   * passed in, so this layer stays free of the curve.
   */
  async addXp(
    userId: string,
    amount: number,
    levelOf: (xp: number) => number,
  ): Promise<{ before: number; after: number; levelBefore: number; levelAfter: number } | null> {
    if (!isObjectId(userId) || amount <= 0) return null;

    const updated = await User.findByIdAndUpdate(
      asId(userId),
      { $inc: { xp: amount } },
      { new: true, projection: { xp: 1, level: 1 } },
    )
      .lean()
      .exec();

    if (!updated) return null;

    const after = updated.xp ?? 0;
    const before = Math.max(0, after - amount);
    const levelBefore = levelOf(before);
    const levelAfter = levelOf(after);

    // Only written when it actually moved. A `$set` on every award would be a
    // second write per match for a value that changes a handful of times in an
    // account's life.
    if (levelAfter !== (updated.level ?? 1)) {
      await User.updateOne({ _id: asId(userId) }, { $set: { level: levelAfter } }).exec();
    }

    return { before, after, levelBefore, levelAfter };
  },

  /** Logs one XP award. Never the authority — see the note on the model. */
  async logXp(input: {
    userId: string;
    reason: string;
    amount: number;
    count: number;
    gameId: string | null;
    balanceAfter: number;
  }): Promise<void> {
    if (!isObjectId(input.userId)) return;

    await XpEvent.create({
      userId: asId(input.userId),
      reason: input.reason,
      amount: Math.max(0, input.amount),
      count: Math.max(1, input.count),
      gameId: input.gameId && isObjectId(input.gameId) ? asId(input.gameId) : null,
      balanceAfter: Math.max(0, input.balanceAfter),
      expiresAt: new Date(Date.now() + XP_EVENT_TTL_MS),
    });
  },

  /** A page of one player's XP history, newest first. */
  async listXp(userId: string, limit: number, skip: number) {
    if (!isObjectId(userId)) return [];

    return XpEvent.find({ userId: asId(userId) })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  async countXp(userId: string): Promise<number> {
    if (!isObjectId(userId)) return 0;
    return XpEvent.countDocuments({ userId: asId(userId) }).exec();
  },

  /**
   * Inserts an unlock, or reports that it already existed.
   *
   * The insert is the claim. A `findOne` first would be a check that can lose
   * a race; letting the unique index decide means exactly one caller is told
   * `true`, and that caller is the only one that pays the reward and announces
   * it. Everything about "an achievement never pays twice" is this method.
   */
  async unlock(input: {
    userId: string;
    key: string;
    valueAtUnlock: number;
    xpAwarded: number;
  }): Promise<boolean> {
    if (!isObjectId(input.userId)) return false;

    try {
      await Achievement.create({
        userId: asId(input.userId),
        key: input.key,
        valueAtUnlock: Math.max(0, input.valueAtUnlock),
        xpAwarded: Math.max(0, input.xpAwarded),
      });
      return true;
    } catch (error) {
      if (isDuplicateAchievement(error)) return false;
      throw error;
    }
  },

  /** Every achievement one player has unlocked, newest first. */
  async listUnlocked(userId: string): Promise<AchievementDocument[]> {
    if (!isObjectId(userId)) return [];

    return Achievement.find({ userId: asId(userId) })
      .sort({ createdAt: -1 })
      .lean()
      .exec() as Promise<AchievementDocument[]>;
  },

  /** Just the keys, for the evaluator's "what is already unlocked" check. */
  async unlockedKeys(userId: string): Promise<Set<string>> {
    if (!isObjectId(userId)) return new Set();

    const rows = await Achievement.find({ userId: asId(userId) })
      .select({ key: 1 })
      .lean()
      .exec();

    return new Set(rows.map((row) => String(row.key)));
  },
};
