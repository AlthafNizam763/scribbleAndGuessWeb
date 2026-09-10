import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { WORD_DIFFICULTIES } from '@/constants/room.constants';

/**
 * One turn: one drawer, one word, one countdown.
 *
 * ## The word lives here, and only here
 *
 * `word` is the secret the whole game protects (brief section 21). It is
 * written to this document at selection time and read back by the guess
 * engine, but it is never included in a broadcast until the turn ends. The
 * serializer that builds `s:game:state` takes the recipient's id as an
 * argument precisely so this field can be omitted for everybody but the
 * drawer — see `serializeGameState` in `game.service.ts`.
 */

const guessRecordSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    /** 1 for the first correct guesser, 2 for the second, and so on. */
    order: { type: Number, required: true },
    /** Milliseconds left on the clock when it landed — the time bonus input. */
    msRemaining: { type: Number, required: true },
    points: { type: Number, required: true },
    guessedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const strokeSchema = new Schema(
  {
    id: { type: String, required: true },
    a: { type: String, required: true },
    /** Points as `[x, y]` pairs, normalised to 0..1 (brief section 23). */
    p: { type: [[Number]], default: [] },
    c: { type: Number, required: true },
    w: { type: Number, required: true },
    t: { type: String, default: 'pen' },
    ts: { type: Number, default: 0 },
  },
  { _id: false },
);

const roundSchema = new Schema(
  {
    gameId: { type: Schema.Types.ObjectId, ref: 'Game', required: true, index: true },
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },

    /** Which pass around the table, 1-based. */
    roundNumber: { type: Number, required: true },
    /** Which turn within the whole match, 1-based and always increasing. */
    turnNumber: { type: Number, required: true },

    drawerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    drawerName: { type: String, required: true },

    /** The secret. Never broadcast before `endedAt` is set. */
    word: { type: String, default: null },
    wordDifficulty: { type: String, enum: WORD_DIFFICULTIES, default: 'medium' },
    /** Alternate spellings that also count as correct. */
    wordAliases: { type: [String], default: [] },

    /** The choices offered to the drawer, kept so a selection can be verified. */
    wordChoices: {
      type: [
        {
          _id: false,
          text: String,
          category: String,
          difficulty: String,
          aliases: [String],
        },
      ],
      default: [],
    },

    /** Letter positions revealed so far (brief section 34). */
    hintIndices: { type: [Number], default: [] },
    hintsRevealed: { type: Number, default: 0 },

    /**
     * The authoritative countdown (brief section 27).
     *
     * Absolute epoch milliseconds, not a duration: a client computes its own
     * display time from these plus its measured clock offset, so nothing
     * depends on a device's idea of "now".
     */
    turnStartMs: { type: Number, default: 0 },
    turnEndMs: { type: Number, default: 0 },

    correctGuesses: { type: [guessRecordSchema], default: [] },
    /** Per-player points from this turn, including the drawer's bonus. */
    scoreDeltas: { type: Map, of: Number, default: () => new Map<string, number>() },

    /**
     * The finished drawing, stored once per turn for replay and debugging.
     *
     * Live strokes are relayed through memory and never touch Mongo (brief
     * section 24); this is a single write at turn end, not a stream.
     */
    snapshot: { type: [strokeSchema], default: [] },

    endedAt: { type: Date, default: null },
    /** Why the turn stopped: the clock, everyone guessing, or the drawer going. */
    endReason: {
      type: String,
      enum: ['timeout', 'allGuessed', 'drawerLeft', 'skipped', 'aborted'],
      default: null,
    },
  },
  { timestamps: true, collection: 'rounds' },
);

roundSchema.index({ gameId: 1, turnNumber: 1 }, { unique: true });

export type RoundDocument = InferSchemaType<typeof roundSchema> & { _id: Types.ObjectId };

export const Round: Model<RoundDocument> =
  (models.Round as Model<RoundDocument>) ?? model<RoundDocument>('Round', roundSchema);
