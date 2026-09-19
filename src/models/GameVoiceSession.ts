import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

import { GAME_IDS } from '@/games/game.types';

/** Signalling/presence metadata only. Audio is never stored or relayed here. */
const gameVoiceSessionSchema = new Schema({
  gameId: { type: String, enum: GAME_IDS, required: true, index: true },
  roomId: { type: Schema.Types.ObjectId, ref: 'GameRoom', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  muted: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  leftAt: { type: Date, default: null },
}, { timestamps: true, collection: 'gameVoiceSessions' });

gameVoiceSessionSchema.index({ roomId: 1, userId: 1, active: 1 });
export type GameVoiceSessionDocument = InferSchemaType<typeof gameVoiceSessionSchema>;
export const GameVoiceSession: Model<GameVoiceSessionDocument> =
  (models.GameVoiceSession as Model<GameVoiceSessionDocument>) ?? model('GameVoiceSession', gameVoiceSessionSchema);
