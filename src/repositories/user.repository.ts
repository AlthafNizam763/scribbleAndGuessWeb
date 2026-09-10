import { Types } from 'mongoose';

import { User, type UserDocument } from '@/models/User';
import type { AuthProvider } from '@/types/auth.types';

/**
 * Data access for `users`.
 *
 * Repositories here are deliberately thin: they own queries and nothing else.
 * No permission checks, no scoring, no broadcasting — that all lives in the
 * services, so a query can be reused by any caller without dragging rules
 * along with it.
 */

export interface CreateUserInput {
  username: string;
  avatarId: number;
  avatarColorIndex: number;
  provider: AuthProvider;
  email?: string | null;
}

/** Whether a string is a well-formed Mongo id, before it reaches a query. */
export function isObjectId(value: string): boolean {
  return Types.ObjectId.isValid(value) && String(new Types.ObjectId(value)) === value;
}

export const userRepository = {
  async create(input: CreateUserInput): Promise<UserDocument & { _id: Types.ObjectId }> {
    const user = await User.create({
      username: input.username,
      avatarId: input.avatarId,
      avatarColorIndex: input.avatarColorIndex,
      authProvider: input.provider,
      email: input.email ?? null,
      lastSeenAt: new Date(),
    });
    return user as UserDocument & { _id: Types.ObjectId };
  },

  async findById(id: string) {
    if (!isObjectId(id)) return null;
    return User.findById(id).lean().exec();
  },

  async findByEmail(email: string) {
    return User.findOne({ email: email.trim().toLowerCase() }).lean().exec();
  },

  /** Updates the profile fields a player is allowed to change. */
  async updateProfile(
    id: string,
    patch: Partial<Pick<UserDocument, 'username' | 'avatarId' | 'avatarColorIndex'>>,
  ) {
    if (!isObjectId(id)) return null;
    return User.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true })
      .lean()
      .exec();
  },

  /**
   * Stamps liveness without loading the document.
   *
   * Called on connect and on reconnect, never on a timer: writing presence
   * every second would be a write per player per second for information
   * nothing reads at that resolution (brief section 37).
   */
  async touch(id: string): Promise<void> {
    if (!isObjectId(id)) return;
    await User.updateOne({ _id: id }, { $set: { lastSeenAt: new Date() } }).exec();
  },

  /**
   * Folds one finished match into a player's lifetime totals.
   *
   * `$inc` rather than read-modify-write: two games finishing at once for the
   * same player would otherwise race and lose one of the increments.
   */
  async recordGameResult(
    id: string,
    input: { scored: number; won: boolean; bestRoundScore: number },
  ): Promise<void> {
    if (!isObjectId(id)) return;
    await User.updateOne(
      { _id: id },
      {
        $inc: {
          gamesPlayed: 1,
          gamesWon: input.won ? 1 : 0,
          totalScore: Math.max(0, input.scored),
        },
        $max: { bestRoundScore: Math.max(0, input.bestRoundScore) },
        $set: { lastSeenAt: new Date() },
      },
    ).exec();
  },

  /** The leaderboard page, highest lifetime score first. */
  async leaderboard(limit: number, skip: number) {
    return User.find({ gamesPlayed: { $gt: 0 } })
      .sort({ totalScore: -1, gamesWon: -1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .select('username avatarId avatarColorIndex totalScore gamesPlayed gamesWon bestRoundScore updatedAt')
      .lean()
      .exec();
  },

  async countRanked(): Promise<number> {
    return User.countDocuments({ gamesPlayed: { $gt: 0 } }).exec();
  },
};
