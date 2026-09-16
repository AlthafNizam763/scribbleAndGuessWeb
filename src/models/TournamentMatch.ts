import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import {
  MATCH_OUTCOME,
  MATCH_STATUS,
} from '@/constants/autoTournament.constants';

/**
 * The bracket: rounds, and the matches inside them.
 *
 * ## Why a match points at a room rather than containing a game
 *
 * The whole point of this feature is that it does not have a game engine. A
 * tournament match *is* an ordinary room running an ordinary match under the
 * existing rules — the same turn order, the same word selection, the same
 * scoring — and this document is the bracket's record of which room that was
 * and how it turned out. Everything about playing it lives where it already
 * lived.
 *
 * ## Why the result is written under a condition rather than on arrival
 *
 * A match can finish more than once from this document's point of view: the
 * game engine ends it, a walkover deadline fires on a room that had already
 * finished, a scheduler restart re-examines a room mid-transition. Every write
 * that completes a match filters on `status` not already being `COMPLETED`, so
 * the first one wins and the rest change nothing. That is what makes winner
 * advancement idempotent — the advance only happens on a write that actually
 * modified a row.
 */

const tournamentRoundSchema = new Schema(
  {
    tournamentId: { type: Schema.Types.ObjectId, ref: 'AutoTournament', required: true },
    /** 1-based. Round 1 is the widest; the last round is the final. */
    roundNumber: { type: Number, required: true, min: 1 },
    /** "Quarter-final", "Final" — computed once so every client agrees. */
    name: { type: String, required: true },
    /** How many matches this round contains. */
    matchCount: { type: Number, required: true, min: 0 },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'tournament_rounds' },
);

/** One row per round per tournament, and the order to read them in. */
tournamentRoundSchema.index(
  { tournamentId: 1, roundNumber: 1 },
  { unique: true, name: 'one_round_per_number' },
);

/**
 * One pairing.
 *
 * ## The two participant slots
 *
 * `slotA` and `slotB` hold registration ids, not user ids, because a bot is a
 * legitimate participant and has no user row. A null slot means "the round
 * below has not decided this yet"; a match whose *other* slot is also null in
 * round one is a bye, and is completed immediately at seeding.
 */
const tournamentMatchSchema = new Schema(
  {
    tournamentId: { type: Schema.Types.ObjectId, ref: 'AutoTournament', required: true },
    roundNumber: { type: Number, required: true, min: 1 },
    /** 1-based within the round, and the order the bracket is drawn in. */
    matchNumber: { type: Number, required: true, min: 1 },

    slotA: { type: Schema.Types.ObjectId, ref: 'TournamentRegistration', default: null },
    slotB: { type: Schema.Types.ObjectId, ref: 'TournamentRegistration', default: null },

    status: {
      type: String,
      enum: Object.values(MATCH_STATUS),
      default: MATCH_STATUS.pending,
    },

    /**
     * The room this match is played in, and the game inside it.
     *
     * Written when the match becomes `READY`. The room is created protected —
     * only the two participants may take a seat — and is closed when the match
     * completes, so a bracket never leaves rooms lying around.
     */
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', default: null },
    roomCode: { type: String, default: null },
    gameId: { type: Schema.Types.ObjectId, ref: 'Game', default: null },

    /** When the room opened, so the entry deadline can be computed from it. */
    readyAt: { type: Date, default: null },
    /** Past this, the match is decided without being played. */
    entryDeadlineAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    winnerRegistrationId: {
      type: Schema.Types.ObjectId,
      ref: 'TournamentRegistration',
      default: null,
    },
    loserRegistrationId: {
      type: Schema.Types.ObjectId,
      ref: 'TournamentRegistration',
      default: null,
    },
    outcome: {
      type: String,
      enum: [...Object.values(MATCH_OUTCOME), null],
      default: null,
    },

    /** Final scores, for the bracket to show what the match was like. */
    scoreA: { type: Number, default: 0, min: 0 },
    scoreB: { type: Number, default: 0, min: 0 },

    /**
     * Where the winner goes.
     *
     * Precomputed at seeding rather than derived from arithmetic at
     * advancement time. The arithmetic is not hard — match N of round R feeds
     * slot (N mod 2) of match ceil(N/2) of round R+1 — but doing it in one
     * place, once, means a bracket with a bye in it cannot be advanced into a
     * pairing that the seeder did not actually create.
     */
    nextMatchNumber: { type: Number, default: null },
    /** Which slot of the next match the winner lands in. */
    nextMatchSlot: { type: String, enum: ['A', 'B', null], default: null },
  },
  { timestamps: true, collection: 'tournament_matches' },
);

/**
 * One match per position in the bracket.
 *
 * This is what makes bracket generation idempotent: the seeder inserts every
 * match of every round in one unordered bulk write, and a second seeder racing
 * it collides on every row rather than building a second bracket beside the
 * first.
 */
tournamentMatchSchema.index(
  { tournamentId: 1, roundNumber: 1, matchNumber: 1 },
  { unique: true, name: 'one_match_per_bracket_position' },
);

/** The scheduler's sweep for matches whose entry deadline has passed. */
tournamentMatchSchema.index({ status: 1, entryDeadlineAt: 1 });

/** "Which match is this room playing?" — the game-end hook's lookup. */
tournamentMatchSchema.index({ roomId: 1 });

/** A participant's own matches, for "where do I play next". */
tournamentMatchSchema.index({ slotA: 1 });
tournamentMatchSchema.index({ slotB: 1 });

export type TournamentRoundDocument = InferSchemaType<typeof tournamentRoundSchema> & {
  _id: Types.ObjectId;
};
export type TournamentMatchDocument = InferSchemaType<typeof tournamentMatchSchema> & {
  _id: Types.ObjectId;
};

export const TournamentRound: Model<TournamentRoundDocument> =
  (models.TournamentRound as Model<TournamentRoundDocument>) ??
  model<TournamentRoundDocument>('TournamentRound', tournamentRoundSchema);

export const TournamentMatch: Model<TournamentMatchDocument> =
  (models.TournamentMatch as Model<TournamentMatchDocument>) ??
  model<TournamentMatchDocument>('TournamentMatch', tournamentMatchSchema);
