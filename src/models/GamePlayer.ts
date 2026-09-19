import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

import { GAME_IDS } from '@/games/game.types';

/** Match membership/history. Bots deliberately carry `userId: null`. */
const gamePlayerSchema = new Schema({
  gameId: { type: String, enum: GAME_IDS, required: true, index: true },
  roomId: { type: Schema.Types.ObjectId, ref: 'GameRoom', required: true, index: true },
  matchId: { type: Schema.Types.ObjectId, ref: 'GameMatch', required: true, index: true },
  playerId: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  isBot: { type: Boolean, default: false },
  placement: { type: Number, default: null },
  score: { type: Number, default: 0 },
}, { timestamps: true, collection: 'gamePlayers' });

gamePlayerSchema.index({ matchId: 1, playerId: 1 }, { unique: true });
gamePlayerSchema.index({ matchId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } });
export type GamePlayerDocument = InferSchemaType<typeof gamePlayerSchema>;
export const GamePlayer: Model<GamePlayerDocument> =
  (models.GamePlayer as Model<GamePlayerDocument>) ?? model('GamePlayer', gamePlayerSchema);
