import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

/**
 * One user blocking another.
 *
 * ## Directional, unlike a friendship
 *
 * A block is deliberately *not* stored as a sorted pair. It belongs to the
 * person who made it: they can lift it, the other party cannot see it, and
 * both directions can exist independently. So the row reads exactly as it
 * means — `blockerId` blocked `blockedUserId` — and the unique index keys on
 * that order.
 *
 * ## What is not stored
 *
 * No reason, and no notification state. A blocked user is never told they were
 * blocked (brief: "do not reveal unnecessary block details to the blocked
 * user"), so there is nothing for them to read and nothing here to leak.
 */

const blockSchema = new Schema(
  {
    blockerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    blockedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'blocks' },
);

/** One block per (blocker, blocked) pair, so blocking twice is a no-op. */
blockSchema.index({ blockerId: 1, blockedUserId: 1 }, { unique: true });

/**
 * "Who have I blocked", newest first — the list endpoint.
 *
 * `blockerId` alone is this index's prefix, so no separate single-field index
 * is declared for it.
 */
blockSchema.index({ blockerId: 1, createdAt: -1 });

/**
 * "Who has blocked me".
 *
 * Needed because a block has to bite in both directions even though only one
 * side can see it: the blocked user must not be able to send a request to, or
 * be matched into a Quick Play room with, the person who blocked them.
 */
blockSchema.index({ blockedUserId: 1 });

export type BlockDocument = InferSchemaType<typeof blockSchema> & { _id: Types.ObjectId };

export const Block: Model<BlockDocument> =
  (models.Block as Model<BlockDocument>) ?? model<BlockDocument>('Block', blockSchema);
