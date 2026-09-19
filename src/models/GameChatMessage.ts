import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

import { GAME_IDS } from '@/games/game.types';

const gameChatMessageSchema = new Schema({
  gameId: { type: String, enum: GAME_IDS, required: true, index: true },
  roomId: { type: Schema.Types.ObjectId, ref: 'GameRoom', required: true, index: true },
  matchId: { type: Schema.Types.ObjectId, ref: 'GameMatch', default: null, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  username: { type: String, default: '' },
  message: { type: String, required: true, maxlength: 500 },
  type: { type: String, enum: ['chat', 'system'], default: 'chat' },
}, { timestamps: { createdAt: true, updatedAt: false }, collection: 'gameChatMessages' });

gameChatMessageSchema.index({ roomId: 1, createdAt: -1 });
export type GameChatMessageDocument = InferSchemaType<typeof gameChatMessageSchema>;
export const GameChatMessage: Model<GameChatMessageDocument> =
  (models.GameChatMessage as Model<GameChatMessageDocument>) ?? model('GameChatMessage', gameChatMessageSchema);
