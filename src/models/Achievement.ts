import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

/**
 * One achievement, unlocked once, by one player.
 *
 * ## Why the unlock is stored and the definition is not
 *
 * The catalogue in `progression.constants.ts` is code: the same for everybody,
 * versioned with the release, and readable by the evaluator without a database
 * round trip on the end-of-match path. What differs between players — and the
 * only thing that does — is which keys they have reached and when. So this
 * collection holds the *event*, not the achievement.
 *
 * That is also why `key` is a plain string rather than an enum of the current
 * catalogue: a row written by an older release must still read back after a
 * key is retired, and an enum would make the old row fail validation on every
 * subsequent save. Keys are append-only for the same reason — reusing one
 * would hand every player who unlocked the old meaning the new one for free.
 *
 * ## The unique index is the duplicate rule
 *
 * The brief asks that an achievement never pay out twice. The service checks
 * before it writes, and that check can lose a race: two matches finishing in
 * the same instant both see the achievement unlocked. What settles it is the
 * index below — exactly one insert survives, and the loser's duplicate-key
 * error tells the service not to announce or pay again. A read-then-write
 * without the index would be correct only most of the time, which for a reward
 * is another way of saying wrong.
 */

const achievementSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /** The catalogue key. Stable, stored, never renamed. */
    key: { type: String, required: true, trim: true },

    /**
     * What the watched counter stood at when this unlocked.
     *
     * Kept because it is the only record of *how* it was earned once the
     * counter has moved on — a player who unlocked "100 correct guesses" at
     * exactly 100 and now has 4,000 has nothing else that says when.
     */
    valueAtUnlock: { type: Number, default: 0, min: 0 },

    /** XP actually paid for this unlock, so the history reconciles. */
    xpAwarded: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, collection: 'achievements' },
);

/** One unlock per player per achievement. This is the whole duplicate story. */
achievementSchema.index({ userId: 1, key: 1 }, { unique: true });

/**
 * A player's trophy case, newest first.
 *
 * `userId` leads because it is the equality predicate on every read, and
 * `createdAt` follows so the profile's ordering comes off the index rather
 * than a blocking sort.
 */
achievementSchema.index({ userId: 1, createdAt: -1 });

export type AchievementDocument = InferSchemaType<typeof achievementSchema> & {
  _id: Types.ObjectId;
};

export const Achievement: Model<AchievementDocument> =
  (models.Achievement as Model<AchievementDocument>) ??
  model<AchievementDocument>('Achievement', achievementSchema);
