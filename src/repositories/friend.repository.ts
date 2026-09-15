import { Types } from 'mongoose';

import { FRIEND_REQUEST_STATUS, type FriendRequestStatus } from '@/constants/social.constants';
import { FriendRequest, type FriendRequestDocument } from '@/models/FriendRequest';
import { Friendship, type FriendshipDocument } from '@/models/Friendship';
import { isObjectId } from '@/repositories/user.repository';

/**
 * Data access for `friend_requests` and `friendships`.
 *
 * Both collections live here because they are written together: accepting a
 * request flips one row and inserts the other, and a repository split across
 * the two would make that pair of writes look like two unrelated operations.
 * As everywhere else in this layer there are no rules — who *may* accept is
 * the service's business.
 */

/**
 * The pair key both collections order their ids by.
 *
 * Sorted by the hex string rather than by `ObjectId` comparison on purpose:
 * the same two ids must produce the same key from any caller, and a string
 * sort is the one ordering that is stable across a serialisation boundary.
 */
export function pairOf(a: string, b: string): { low: string; high: string; key: string } {
  const [low, high] = a < b ? [a, b] : [b, a];
  return { low, high, key: `${low}:${high}` };
}

const asId = (value: string): Types.ObjectId => new Types.ObjectId(value);

export const friendRepository = {
  // ------------------------------------------------------------- requests --

  /**
   * Inserts a pending request.
   *
   * Throws Mongo's duplicate-key error (code 11000) when a pending request
   * already exists between the two users in *either* direction — the partial
   * unique index on `pairKey` is what decides that, not a prior read. The
   * service turns that error into a refusal, which is what closes the race
   * between two people asking each other at the same instant.
   */
  async createRequest(senderId: string, receiverId: string): Promise<FriendRequestDocument> {
    const { key } = pairOf(senderId, receiverId);

    return (await FriendRequest.create({
      senderId: asId(senderId),
      receiverId: asId(receiverId),
      status: FRIEND_REQUEST_STATUS.pending,
      pairKey: key,
    })) as FriendRequestDocument;
  },

  async findRequestById(requestId: string) {
    if (!isObjectId(requestId)) return null;
    return FriendRequest.findById(requestId).lean().exec();
  },

  /** The pending request between two users, whichever way round it points. */
  async findPendingBetween(a: string, b: string) {
    if (!isObjectId(a) || !isObjectId(b)) return null;
    return FriendRequest.findOne({
      pairKey: pairOf(a, b).key,
      status: FRIEND_REQUEST_STATUS.pending,
    })
      .lean()
      .exec();
  },

  /**
   * Moves a request out of `pending`, and says whether it actually moved.
   *
   * The `status: pending` in the filter is the concurrency control: two taps
   * on Accept, or an Accept racing a Cancel, both reach here and only the
   * first one matches. The loser gets `false`, and the service reports that
   * the request is no longer open rather than performing the action twice.
   */
  async resolveRequest(requestId: string, status: FriendRequestStatus): Promise<boolean> {
    if (!isObjectId(requestId)) return false;

    const result = await FriendRequest.updateOne(
      { _id: requestId, status: FRIEND_REQUEST_STATUS.pending },
      { $set: { status } },
    ).exec();

    return result.modifiedCount === 1;
  },

  /** Every pending request pointing at this user, newest first. */
  async listIncoming(userId: string, limit: number, skip: number) {
    if (!isObjectId(userId)) return [];
    return FriendRequest.find({
      receiverId: asId(userId),
      status: FRIEND_REQUEST_STATUS.pending,
    })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  /** Every pending request this user has sent, newest first. */
  async listOutgoing(userId: string, limit: number, skip: number) {
    if (!isObjectId(userId)) return [];
    return FriendRequest.find({
      senderId: asId(userId),
      status: FRIEND_REQUEST_STATUS.pending,
    })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  async countIncoming(userId: string): Promise<number> {
    if (!isObjectId(userId)) return 0;
    return FriendRequest.countDocuments({
      receiverId: asId(userId),
      status: FRIEND_REQUEST_STATUS.pending,
    }).exec();
  },

  async countOutgoing(userId: string): Promise<number> {
    if (!isObjectId(userId)) return 0;
    return FriendRequest.countDocuments({
      senderId: asId(userId),
      status: FRIEND_REQUEST_STATUS.pending,
    }).exec();
  },

  /**
   * Cancels every pending request between two users, in both directions.
   *
   * Used by the block path, where "cancel mine and reject theirs" is one
   * decision rather than two: the point is that after a block there is no open
   * request in either direction, and doing it as a single update is what makes
   * that true even if both rows somehow exist.
   */
  async cancelPendingBetween(a: string, b: string): Promise<number> {
    if (!isObjectId(a) || !isObjectId(b)) return 0;

    const result = await FriendRequest.updateMany(
      { pairKey: pairOf(a, b).key, status: FRIEND_REQUEST_STATUS.pending },
      { $set: { status: FRIEND_REQUEST_STATUS.cancelled } },
    ).exec();

    return result.modifiedCount;
  },

  // ---------------------------------------------------------- friendships --

  /**
   * Creates the friendship for a pair, or leaves an existing one alone.
   *
   * An upsert rather than an insert: accepting is the end of a race the
   * database has already arbitrated, and if the pair are somehow friends
   * already then the right outcome is "they are friends", not an error a user
   * would have to read.
   */
  async createFriendship(a: string, b: string, requestId: string | null): Promise<void> {
    const { low, high } = pairOf(a, b);

    await Friendship.updateOne(
      { userAId: asId(low), userBId: asId(high) },
      {
        $setOnInsert: {
          userAId: asId(low),
          userBId: asId(high),
          requestId: requestId && isObjectId(requestId) ? asId(requestId) : null,
        },
      },
      { upsert: true },
    ).exec();
  },

  async areFriends(a: string, b: string): Promise<boolean> {
    if (!isObjectId(a) || !isObjectId(b)) return false;
    const { low, high } = pairOf(a, b);
    return (await Friendship.exists({ userAId: asId(low), userBId: asId(high) }).exec()) !== null;
  },

  /** Removes the friendship for a pair. One row, so it cannot half-succeed. */
  async removeFriendship(a: string, b: string): Promise<boolean> {
    if (!isObjectId(a) || !isObjectId(b)) return false;

    const { low, high } = pairOf(a, b);
    const result = await Friendship.deleteOne({
      userAId: asId(low),
      userBId: asId(high),
    }).exec();

    return result.deletedCount === 1;
  },

  /**
   * Every friend id of one user, as strings.
   *
   * Returns ids rather than joined user rows because that is what both callers
   * want: the friends leaderboard feeds them straight into an `$in` the
   * ranking index can serve, and the friends list pages them before loading
   * any profile. A `$lookup` here would load every friend's whole document to
   * build a page of twenty-five.
   */
  async friendIdsOf(userId: string): Promise<string[]> {
    if (!isObjectId(userId)) return [];

    const id = asId(userId);
    const rows = await Friendship.find({ $or: [{ userAId: id }, { userBId: id }] })
      .select('userAId userBId')
      .lean()
      .exec();

    return rows.map((row: Pick<FriendshipDocument, 'userAId' | 'userBId'>) =>
      String(row.userAId) === userId ? String(row.userBId) : String(row.userAId),
    );
  },

  /** The pair rows themselves, for a list that shows "friends since". */
  async listFriendships(userId: string, limit: number, skip: number) {
    if (!isObjectId(userId)) return [];

    const id = asId(userId);
    return Friendship.find({ $or: [{ userAId: id }, { userBId: id }] })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  async countFriends(userId: string): Promise<number> {
    if (!isObjectId(userId)) return 0;
    const id = asId(userId);
    return Friendship.countDocuments({ $or: [{ userAId: id }, { userBId: id }] }).exec();
  },
};

/** Whether a thrown value is Mongo's duplicate-key error. */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}
