import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { INPUT_LIMITS } from '@/constants/game.constants';
import { CHAT_TYPE } from '@/constants/room.constants';

/**
 * A line of room chat (brief section 36).
 *
 * Guesses travel down the same channel as chat, which is why `type` matters
 * so much: a wrong guess is shown to everyone as an ordinary message, while a
 * correct one is replaced by "Althaf guessed correctly!" and the text itself
 * is never persisted or broadcast. Storing the raw guess would put the answer
 * in a document any later query could read back.
 */

const chatMessageSchema = new Schema(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    gameId: { type: Schema.Types.ObjectId, ref: 'Game', default: null },
    roundId: { type: Schema.Types.ObjectId, ref: 'Round', default: null },

    /** Null for system lines, which have no author. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    username: { type: String, default: '' },

    message: { type: String, required: true, maxlength: INPUT_LIMITS.maxChatLength },

    type: {
      type: String,
      enum: Object.values(CHAT_TYPE),
      default: CHAT_TYPE.chat,
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'chatMessages' },
);

// Serves "the last N lines of this room, newest first" from the index.
chatMessageSchema.index({ roomId: 1, createdAt: -1 });

export type ChatMessageDocument = InferSchemaType<typeof chatMessageSchema> & {
  _id: Types.ObjectId;
};

export const ChatMessage: Model<ChatMessageDocument> =
  (models.ChatMessage as Model<ChatMessageDocument>) ??
  model<ChatMessageDocument>('ChatMessage', chatMessageSchema);
