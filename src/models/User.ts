import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

import { INPUT_LIMITS } from '@/constants/game.constants';

/**
 * A player account (brief section 5).
 *
 * Guests get a row here too. They are real users with a real `_id` — that id
 * is what rooms, scores and reports reference — they simply have no
 * credentials yet. Keeping guests in the same collection is what lets section
 * 6's "upgrade to Google/Apple/email later" happen by adding a provider to an
 * existing row rather than migrating anybody's history.
 */

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
      minlength: INPUT_LIMITS.minNameLength,
      maxlength: INPUT_LIMITS.maxNameLength,
    },

    /**
     * Which of the 18 procedural doodle avatars this player draws as.
     *
     * Stored as the client's `avatarId`/`avatarColorIndex` pair rather than an
     * image: the app draws avatars with a `CustomPainter`, so there is no asset
     * to store and nothing to serve.
     */
    avatarId: { type: Number, required: true, default: 0, min: 0, max: INPUT_LIMITS.avatarCount - 1 },
    avatarColorIndex: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: INPUT_LIMITS.avatarColorCount - 1,
    },

    /**
     * Optional, and only set once an account is linked.
     *
     * Uniqueness is enforced by the partial index declared below rather than
     * by `unique: true` here — see the note on that index for why neither a
     * plain nor a sparse unique index works for this field.
     */
    email: { type: String, trim: true, lowercase: true, default: undefined },

    /** Password hash. Never selected by default; only the auth service asks. */
    passwordHash: { type: String, default: null, select: false },

    authProvider: {
      type: String,
      enum: ['guest', 'google', 'apple', 'email'],
      required: true,
      default: 'guest',
    },

    lastSeenAt: { type: Date, default: Date.now },

    /**
     * Lifetime statistics.
     *
     * Written only by the game engine at the end of a match. The `PATCH
     * /api/users/me` handler explicitly refuses these fields (brief section 8)
     * — a client that could set its own `totalScore` would make the
     * leaderboard meaningless.
     */
    gamesPlayed: { type: Number, default: 0, min: 0 },
    gamesWon: { type: Number, default: 0, min: 0 },
    totalScore: { type: Number, default: 0, min: 0 },
    bestRoundScore: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
    collection: 'users',
  },
);

/**
 * One account per email — but only among rows that actually have one.
 *
 * A plain unique index would reject the second guest ever created, since every
 * guest has no email and they would all collide. A *sparse* unique index does
 * not fix it either: sparse skips documents where the field is **absent**, and
 * a schema default of `null` makes the field present-and-null on every guest,
 * so they collide just the same.
 *
 * A partial index keyed on the field being a string is the version that works:
 * guests are not indexed at all, and two linked accounts still cannot share an
 * address.
 */
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);

// Serves the leaderboard's default ordering directly from the index.
userSchema.index({ totalScore: -1, gamesWon: -1 });

// Lets the sweeper find stale guest accounts without a collection scan.
userSchema.index({ lastSeenAt: -1 });

export type UserDocument = InferSchemaType<typeof userSchema>;

/**
 * `models.User ?? model(...)` rather than a bare `model(...)`.
 *
 * Next.js re-evaluates this module on every hot reload, and registering the
 * same model name twice makes Mongoose throw `OverwriteModelError`.
 */
export const User: Model<UserDocument> =
  (models.User as Model<UserDocument>) ?? model<UserDocument>('User', userSchema);
