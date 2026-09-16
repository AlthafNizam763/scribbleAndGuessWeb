import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { BOT_DIFFICULTY } from '@/constants/autoTournament.constants';

/**
 * The AI players, and the lock the scheduler runs under.
 *
 * ## Why bot profiles are stored at all when the roster is a constant
 *
 * Two reasons, and neither is configurability.
 *
 * The first is that a bot has to be *seatable*. The room document's player
 * array types `userId` as an ObjectId, and the game engine keys every seat,
 * score and turn by that id. Giving each bot a stored row gives it a stable
 * ObjectId that survives a restart, so a bot that was drawing when the process
 * died is the same participant when the bracket is re-read — rather than a new
 * identity each boot, which would orphan every match it had played.
 *
 * The second is that it makes bot identity *checkable*. `botId` is validated
 * against this collection before a seat is created, so there is one list of
 * things that may be a bot and it is not in the client.
 *
 * ## Why difficulty lives on the registration and not here
 *
 * A profile is a character; a difficulty is how hard that character plays in
 * one tournament. The same Doodler can be NORMAL in slot 1 and HARD in slot 3.
 * The field here is only the default used when a tournament does not say.
 */

const tournamentBotProfileSchema = new Schema(
  {
    /** The stable key from `BOT_PROFILES`. Never changes. */
    botId: { type: String, required: true, trim: true },

    displayName: { type: String, required: true, trim: true },
    avatarId: { type: Number, default: 0 },
    avatarColorIndex: { type: Number, default: 0 },

    difficulty: {
      type: String,
      enum: Object.values(BOT_DIFFICULTY),
      default: BOT_DIFFICULTY.normal,
    },

    /**
     * Whether this bot may be seated.
     *
     * A switch that takes one character out of rotation without deleting the
     * row — which would break every finished bracket that names it.
     */
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'tournament_bot_profiles' },
);

/** One row per bot. The seeder upserts on this, so re-seeding is a no-op. */
tournamentBotProfileSchema.index({ botId: 1 }, { unique: true });

/** The fill path's query: which bots are available to seat. */
tournamentBotProfileSchema.index({ active: 1 });

/**
 * The scheduler's distributed lock.
 *
 * ## How one row makes concurrent schedulers safe
 *
 * Acquiring is a single `findOneAndUpdate` with an upsert, filtered on the
 * lock being either unheld or *expired*. Mongo applies that atomically, so of
 * two processes trying at the same instant exactly one modifies the row and
 * the other gets nothing back. There is no read-then-write, so there is no
 * window between them.
 *
 * ## Why the lease is a timestamp and not a flag
 *
 * A process holding a boolean lock that then crashes holds it for ever. A
 * lease expires on its own, so the worst case of a crash mid-tick is that
 * tournaments stall for one lease and then carry on — which is why the release
 * path is best-effort: if it never runs, nothing is stuck.
 *
 * `owner` is not consulted to decide anything. It is there so a log line can
 * say which instance is holding things up.
 */
const schedulerLockSchema = new Schema(
  {
    key: { type: String, required: true },
    owner: { type: String, required: true },
    /** When this lease lapses and the lock may be taken by anybody. */
    expiresAt: { type: Date, required: true },
    acquiredAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'tournament_scheduler_locks' },
);

/** One row per lock key. The whole mutual-exclusion story. */
schedulerLockSchema.index({ key: 1 }, { unique: true });

export type TournamentBotProfileDocument = InferSchemaType<
  typeof tournamentBotProfileSchema
> & { _id: Types.ObjectId };
export type TournamentSchedulerLockDocument = InferSchemaType<typeof schedulerLockSchema> & {
  _id: Types.ObjectId;
};

export const TournamentBotProfile: Model<TournamentBotProfileDocument> =
  (models.TournamentBotProfile as Model<TournamentBotProfileDocument>) ??
  model<TournamentBotProfileDocument>('TournamentBotProfile', tournamentBotProfileSchema);

export const TournamentSchedulerLock: Model<TournamentSchedulerLockDocument> =
  (models.TournamentSchedulerLock as Model<TournamentSchedulerLockDocument>) ??
  model<TournamentSchedulerLockDocument>('TournamentSchedulerLock', schedulerLockSchema);
