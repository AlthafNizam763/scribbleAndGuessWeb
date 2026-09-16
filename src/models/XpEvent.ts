import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { XP_HISTORY_LIMITS } from '@/constants/progression.constants';

/**
 * One XP award, as it happened.
 *
 * ## What this is for
 *
 * The brief asks for an XP history, and the honest reason to keep one is that
 * a number which goes up on its own is impossible to trust. A player who
 * gained 140 XP after a match should be able to see that it was 25 for
 * finishing, 50 for winning, 40 for four correct guesses and 25 for an
 * achievement — not a single unexplained jump.
 *
 * It is also the audit trail for the rule the brief cares most about: XP is
 * server-computed, and a disputed total can be reconciled against the sum of
 * these rows.
 *
 * ## Why it is not the authority
 *
 * `users.xp` is. Deriving a total by summing this collection would make every
 * profile read an aggregation over a player's whole history, and would make
 * the total wrong the moment a row expired. So the rows are a *log*: they
 * explain the balance, they do not define it. That is also why they are
 * allowed to expire — see below — while the balance never does.
 */

const xpEventSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * Which award this was.
     *
     * A plain string rather than an enum of the current `XpReason` values, for
     * the same reason `Achievement.key` is: a row written by an older release
     * has to read back after a reason is retired.
     */
    reason: { type: String, required: true, trim: true },

    /** How much was paid. Always positive; XP is never taken away. */
    amount: { type: Number, required: true, min: 0 },

    /** How many times the award applied, e.g. four correct guesses. */
    count: { type: Number, default: 1, min: 1 },

    /** The match it came from, when it came from one. */
    gameId: { type: Schema.Types.ObjectId, ref: 'Game', default: null },

    /** The player's XP *after* this award, so a row explains a level-up. */
    balanceAfter: { type: Number, default: 0, min: 0 },

    /**
     * When Mongo may delete this row.
     *
     * The same argument as `Notification.expiresAt`: this is a log, everything
     * it explains is stored authoritatively elsewhere, and a collection that
     * grows with every correct guess of every player forever is a cost with no
     * reader. Ninety days is long enough to explain a recent level and short
     * enough that the collection stays proportional to active play.
     */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'xp_events' },
);

/** A player's history, newest first. Served straight from the index. */
xpEventSchema.index({ userId: 1, createdAt: -1, _id: -1 });

/** Mongo's sweeper. `expireAfterSeconds: 0` means "delete at `expiresAt`". */
xpEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** How long a history row lives, as a duration. */
export const XP_EVENT_TTL_MS = XP_HISTORY_LIMITS.retentionDays * 24 * 60 * 60 * 1000;

export type XpEventDocument = InferSchemaType<typeof xpEventSchema> & {
  _id: Types.ObjectId;
};

export const XpEvent: Model<XpEventDocument> =
  (models.XpEvent as Model<XpEventDocument>) ??
  model<XpEventDocument>('XpEvent', xpEventSchema);
