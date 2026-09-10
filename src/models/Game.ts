import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { GAME_PHASE } from '@/constants/room.constants';

/**
 * One match played in a room (brief section 17).
 *
 * A room outlives its games: "play again" (brief section 48) closes the
 * current game and opens a new one against the same room, which is what keeps
 * the room code, the seats and the settings while resetting every score. So
 * the history of a room is a list of games, not a mutated single document.
 */

const finalScoreSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    avatarId: { type: Number, default: 0 },
    avatarColorIndex: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    rank: { type: Number, default: 0 },
  },
  { _id: false },
);

const gameSchema = new Schema(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
    roomCode: { type: String, required: true },

    phase: {
      type: String,
      enum: Object.values(GAME_PHASE),
      default: GAME_PHASE.starting,
      required: true,
    },

    /** How many full passes around the table this match plays. */
    totalRounds: { type: Number, required: true },
    /** Which pass is in progress, 1-based. */
    currentRound: { type: Number, default: 1 },

    /**
     * The turn order, fixed when the game starts.
     *
     * Shuffled once and then never re-derived, because the drawer for a given
     * turn has to be the same answer every time it is asked — including after
     * a player leaves mid-match. Whoever left is skipped, not re-dealt.
     */
    turnOrder: { type: [Schema.Types.ObjectId], default: [] },
    /** Index into `turnOrder` for the current turn. */
    turnIndex: { type: Number, default: 0 },

    currentRoundId: { type: Schema.Types.ObjectId, ref: 'Round', default: null },

    /** Words already used this match, so nobody draws the same thing twice. */
    usedWords: { type: [String], default: [] },

    standings: { type: [finalScoreSchema], default: [] },
    winnerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'games' },
);

gameSchema.index({ roomId: 1, createdAt: -1 });
gameSchema.index({ endedAt: 1 });

export type GameDocument = InferSchemaType<typeof gameSchema> & { _id: Types.ObjectId };

export const Game: Model<GameDocument> =
  (models.Game as Model<GameDocument>) ?? model<GameDocument>('Game', gameSchema);
