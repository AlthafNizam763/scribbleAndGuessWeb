import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { FRIEND_REQUEST_STATUS } from '@/constants/social.constants';

/**
 * One friend request, from the moment it is sent until it is resolved.
 *
 * ## Why resolved requests are kept
 *
 * A rejected or cancelled request is not deleted. Keeping the row is what
 * makes "you already asked this person and they said no" answerable without a
 * second collection, and it is what a future rate limit on re-asking would key
 * off. Only `pending` rows constrain anything; everything else is history.
 *
 * ## The pair key, and the rule it enforces
 *
 * A request from A to B must be refused when B already has one pending to A —
 * otherwise two people who ask each other at the same moment end up with two
 * requests and no friendship, each waiting for the other to accept. That rule
 * is *direction-independent*, which a unique index on `(senderId, receiverId)`
 * cannot express: it would happily allow the mirrored row.
 *
 * So the pair is also stored pre-sorted in `pairKey`, and the partial unique
 * index below is declared on that. Two users then have at most one pending
 * request between them in either direction, enforced by the database rather
 * than by a check the service could race against. `partialFilterExpression`
 * scopes the constraint to `pending`, so the same two people may send, reject
 * and send again as often as they like.
 */

const friendRequestSchema = new Schema(
  {
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    receiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    status: {
      type: String,
      enum: Object.values(FRIEND_REQUEST_STATUS),
      required: true,
      default: FRIEND_REQUEST_STATUS.pending,
    },

    /**
     * `"<lower id>:<higher id>"`, written by the repository on insert.
     *
     * Never accepted from a caller and never read as data — it exists only to
     * give the unique index below something order-independent to key on.
     */
    pairKey: { type: String, required: true },
  },
  { timestamps: true, collection: 'friend_requests' },
);

/** At most one pending request between any two users, in either direction. */
friendRequestSchema.index(
  { pairKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: FRIEND_REQUEST_STATUS.pending },
  },
);

/** The incoming list: "who is waiting on me", newest first. */
friendRequestSchema.index({ receiverId: 1, status: 1, createdAt: -1 });

/** The outgoing list: "who am I waiting on", newest first. */
friendRequestSchema.index({ senderId: 1, status: 1, createdAt: -1 });

/**
 * The exact-pair lookup the send path makes before it inserts.
 *
 * Covers `senderId + receiverId + status` as the brief asks. The two indexes
 * above already serve `senderId`, `receiverId` and `status` individually as
 * prefixes, so no single-field index is declared for them: an extra index that
 * a compound prefix already covers costs a write on every insert and buys
 * nothing.
 */
friendRequestSchema.index({ senderId: 1, receiverId: 1, status: 1 });

export type FriendRequestDocument = InferSchemaType<typeof friendRequestSchema> & {
  _id: Types.ObjectId;
};

export const FriendRequest: Model<FriendRequestDocument> =
  (models.FriendRequest as Model<FriendRequestDocument>) ??
  model<FriendRequestDocument>('FriendRequest', friendRequestSchema);
