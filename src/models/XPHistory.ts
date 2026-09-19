import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

import { GAME_IDS } from '@/games/game.types';

/** Idempotent platform-game XP ledger. Never created for an AI bot. */
const xpHistorySchema = new Schema({
  gameId: { type: String, enum: GAME_IDS, required: true, index: true },
  matchId: { type: Schema.Types.ObjectId, ref: 'GameMatch', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  placement: { type: Number, required: true },
  result: { type: String, enum: ['win', 'loss', 'draw'], required: true },
  xpAmount: { type: Number, required: true, min: 0 },
  uniqueRewardKey: { type: String, required: true, unique: true },
}, { timestamps: { createdAt: true, updatedAt: false }, collection: 'xpHistory' });

xpHistorySchema.index({ gameId: 1, matchId: 1, userId: 1 }, { unique: true });
export type XPHistoryDocument = InferSchemaType<typeof xpHistorySchema>;
export const XPHistory: Model<XPHistoryDocument> =
  (models.XPHistory as Model<XPHistoryDocument>) ?? model('XPHistory', xpHistorySchema);
