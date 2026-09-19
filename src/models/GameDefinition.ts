import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

import { GAME_IDS } from '@/games/game.types';

/** Persisted mirror of the static catalogue for operations/reporting. */
const gameDefinitionSchema = new Schema({
  gameId: { type: String, enum: GAME_IDS, required: true, unique: true },
  displayName: { type: String, required: true },
  description: { type: String, required: true },
  icon: { type: String, required: true },
  banner: { type: String, required: true },
  minPlayers: { type: Number, required: true },
  maxPlayers: { type: Number, required: true },
  supportsBots: { type: Boolean, required: true },
  supportsVoice: { type: Boolean, required: true },
  supportsTextChat: { type: Boolean, required: true },
  route: { type: String, required: true },
  status: { type: String, enum: ['live', 'coming_soon'], required: true },
  version: { type: Number, required: true },
}, { timestamps: true, collection: 'gameDefinitions' });

export type GameDefinitionDocument = InferSchemaType<typeof gameDefinitionSchema>;
export const GameDefinition: Model<GameDefinitionDocument> =
  (models.GameDefinition as Model<GameDefinitionDocument>) ?? model('GameDefinition', gameDefinitionSchema);
