import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { DEFAULT_GAME_MODE } from '@/constants/gameModes.constants';
import { TOURNAMENT_FORMAT, TOURNAMENT_LIMITS } from '@/constants/tournament.constants';

/**
 * A scheduled event with its own rules and its own leaderboard.
 *
 * ## Why there is no `status` column
 *
 * A tournament's state is entirely a function of the clock and three stored
 * timestamps. A stored status would be wrong for every tournament between the
 * moment one opens and the moment a scheduled job noticed — and it would need
 * that job to exist. `tournamentService.statusOf` derives it instead, so the
 * answer is always current and nothing has to run.
 *
 * ## Why entries are their own collection
 *
 * A tournament holds up to five thousand entrants, each with a running score.
 * Embedding that array would mean rewriting a five-thousand-element document
 * every time anybody finished a match — and Mongo's 16MB document ceiling
 * would eventually decide the maximum for us.
 */

const tournamentSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: TOURNAMENT_LIMITS.maxNameLength,
    },
    description: {
      type: String,
      trim: true,
      maxlength: TOURNAMENT_LIMITS.maxDescriptionLength,
      default: '',
    },

    format: {
      type: String,
      enum: Object.values(TOURNAMENT_FORMAT),
      default: TOURNAMENT_FORMAT.points,
    },

    /**
     * The rules every match in this tournament plays under.
     *
     * A mode key rather than a settings object: a tournament that could set
     * arbitrary settings would be a way to run a match under rules the room
     * validator never saw, and the mode table already bounds what is playable.
     */
    gameMode: { type: String, default: DEFAULT_GAME_MODE },

    /**
     * Restricts the word pool to a theme, or null for the usual pool.
     *
     * This is what makes "Kerala words challenge" or "Movie words" a
     * tournament rather than a name — the categories are the event.
     */
    categories: { type: [String], default: [] },

    /** The three timestamps every derived status comes from. */
    registerFrom: { type: Date, required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },

    /** What the winner gets. Descriptive; awarding is a separate concern. */
    rewardXp: { type: Number, default: 0, min: 0 },
    rewardBadgeKey: { type: String, trim: true, maxlength: 64, default: null },

    /**
     * Who won, written once when the tournament is closed out.
     *
     * Null while it is running. Stored rather than derived because the board
     * it came from keeps changing shape as old entries expire, and "who won
     * the October cup" must stay answerable afterwards.
     */
    winnerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'tournaments' },
);

/** The listing: what is on now and what is next. */
tournamentSchema.index({ endsAt: 1, startsAt: 1 });

/**
 * One player's standing in one tournament.
 *
 * `score` is the sum of what they scored in matches played inside the window.
 * It is written by the game engine at the end of each match and never by a
 * client — the same rule the global leaderboard follows, for the same reason.
 */
const tournamentEntrySchema = new Schema(
  {
    tournamentId: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    score: { type: Number, default: 0, min: 0 },
    matchesPlayed: { type: Number, default: 0, min: 0 },
    matchesWon: { type: Number, default: 0, min: 0 },

    registeredAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'tournament_entries' },
);

/** One entry per player per tournament. This is the whole duplicate story. */
tournamentEntrySchema.index({ tournamentId: 1, userId: 1 }, { unique: true });

/**
 * The tournament board, served straight from the index.
 *
 * All three keys in the order the query sorts by, with `_id` as the tie-break
 * so paging is stable — the same shape, and the same reasoning, as the world
 * leaderboard's index on `users`.
 */
tournamentEntrySchema.index({ tournamentId: 1, score: -1, matchesWon: -1, _id: 1 });

export type TournamentDocument = InferSchemaType<typeof tournamentSchema> & {
  _id: Types.ObjectId;
};
export type TournamentEntryDocument = InferSchemaType<typeof tournamentEntrySchema> & {
  _id: Types.ObjectId;
};

export const Tournament: Model<TournamentDocument> =
  (models.Tournament as Model<TournamentDocument>) ??
  model<TournamentDocument>('Tournament', tournamentSchema);

export const TournamentEntry: Model<TournamentEntryDocument> =
  (models.TournamentEntry as Model<TournamentEntryDocument>) ??
  model<TournamentEntryDocument>('TournamentEntry', tournamentEntrySchema);
