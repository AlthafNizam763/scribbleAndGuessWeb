import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

/**
 * An accepted friendship, stored once for the pair.
 *
 * ## One row, not two
 *
 * The obvious shape is two rows — `(a -> b)` and `(b -> a)` — so that each
 * user's friend list is a single-field query. It is also the shape that cannot
 * be made correct: nothing stops the pair from ending up half-written, a
 * duplicate is only preventable per direction, and every removal has to find
 * and delete both rows or leave a friendship that exists for one person and
 * not the other.
 *
 * So a friendship is one row whose two ids are stored *sorted*: `userAId` is
 * always the lexicographically smaller hex id. Then the unique index below is
 * the whole duplicate-prevention story, in either direction, and removing a
 * friendship is one `deleteOne` that cannot half-succeed. The cost is that a
 * friend list is an `$or` over two fields rather than one, which the two
 * indexes below serve.
 */

const friendshipSchema = new Schema(
  {
    /** The smaller of the two user ids, as a hex string comparison. */
    userAId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** The larger of the two. */
    userBId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /** Which request produced this friendship, for auditing. */
    requestId: { type: Schema.Types.ObjectId, ref: 'FriendRequest', default: null },
  },
  {
    // `createdAt` is "friends since", which the profile screen shows.
    timestamps: true,
    collection: 'friendships',
  },
);

/** One friendship per pair. The sorted ids are what make this direction-free. */
friendshipSchema.index({ userAId: 1, userBId: 1 }, { unique: true });

/**
 * The two halves of a friend-list query.
 *
 * A user's friends are `{$or: [{userAId: me}, {userBId: me}]}`, and Mongo
 * serves an `$or` by taking one index per branch, so both fields need one.
 */
friendshipSchema.index({ userAId: 1, createdAt: -1 });
friendshipSchema.index({ userBId: 1, createdAt: -1 });

export type FriendshipDocument = InferSchemaType<typeof friendshipSchema> & {
  _id: Types.ObjectId;
};

export const Friendship: Model<FriendshipDocument> =
  (models.Friendship as Model<FriendshipDocument>) ??
  model<FriendshipDocument>('Friendship', friendshipSchema);
