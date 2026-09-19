import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

import { GAME_IDS } from '@/games/game.types';

const gameResultSchema = new Schema({
  gameId: { type: String, enum: GAME_IDS, required: true, index: true },
  roomId: { type: Schema.Types.ObjectId, ref: 'GameRoom', required: true, index: true },
  matchId: { type: Schema.Types.ObjectId, ref: 'GameMatch', required: true, unique: true },
  result: { type: Schema.Types.Mixed, required: true },
  awardedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'gameResults' });

gameResultSchema.index({ gameId: 1, createdAt: -1 });
export type GameResultDocument = InferSchemaType<typeof gameResultSchema>;
export const GameResult: Model<GameResultDocument> =
  (models.GameResult as Model<GameResultDocument>) ?? model('GameResult', gameResultSchema);
