import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { GAME_IDS } from '@/games/game.types';

/** `privateState` is server-only and must never be returned by a controller. */
const gameMatchSchema = new Schema({
  gameId: { type: String, enum: GAME_IDS, required: true, index: true },
  roomId: { type: Schema.Types.ObjectId, ref: 'GameRoom', required: true, index: true },
  status: { type: String, enum: ['waiting', 'playing', 'completed', 'cancelled'], default: 'waiting', index: true },
  turnUserId: { type: String, default: null },
  publicState: { type: Schema.Types.Mixed, default: {} },
  privateState: { type: Schema.Types.Mixed, default: {} },
  result: { type: Schema.Types.Mixed, default: null },
  startedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'gameMatches' });

gameMatchSchema.index({ gameId: 1, roomId: 1, createdAt: -1 });
export type GameMatchDocument = InferSchemaType<typeof gameMatchSchema> & { _id: Types.ObjectId };
export const GameMatch: Model<GameMatchDocument> =
  (models.GameMatch as Model<GameMatchDocument>) ?? model('GameMatch', gameMatchSchema);
