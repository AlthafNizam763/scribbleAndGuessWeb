import { NOTIFICATION_TYPE } from '@/constants/notification.constants';
import { FRIEND_REQUEST_STATUS, PAGE_LIMITS, RELATION, type RelationWire } from '@/constants/social.constants';
import { blockRepository } from '@/repositories/block.repository';
import { friendRepository, isDuplicateKeyError } from '@/repositories/friend.repository';
import { userRepository } from '@/repositories/user.repository';
import { notificationService } from '@/services/notification.service';
import { notifyFriendEvent } from '@/services/social.notify';
import { toUserStats, toUserSummary, type RankableUser } from '@/services/profile.serialize';
import type { FriendDto, FriendRequestDto, UserSummaryDto } from '@/types/social.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Friend requests and friendships.
 *
 * ## Every refusal in one place
 *
 * The rules the brief lists — no self-requests, no duplicates in either
 * direction, nothing to or from a blocked user, nobody acting on somebody
 * else's request — are all enforced here rather than in the validators,
 * because every one of them is a question about server state. A validator can
 * check that a body has a `receiverId`; only this layer can know whether that
 * person has blocked you.
 *
 * ## Checks, and the one that actually decides
 *
 * The duplicate check reads before it writes, and that read can lose a race:
 * two people tapping "Add friend" on each other in the same instant both see
 * no pending request. What settles it is the partial unique index on
 * `pairKey`, which lets exactly one insert through and fails the other with a
 * duplicate-key error that `sendRequest` turns into the same refusal the
 * pre-check would have given. The read exists to produce a good message in the
 * ordinary case; the index is what makes the rule true.
 *
 * ## What the other party is told
 *
 * Sending, accepting and rejecting push a socket event to the user it concerns
 * so their list updates without a poll. The payloads carry a display name and
 * an avatar and nothing else — never an email, never a token, never a block.
 */

export class FriendService {
  // -------------------------------------------------------------- sending --

  /**
   * Sends a friend request from [senderId] to [receiverId].
   *
   * Refuses, in this order: yourself, an account that does not exist, a block
   * in either direction, an existing friendship, and an already-pending
   * request either way round.
   */
  async sendRequest(senderId: string, receiverId: string): Promise<FriendRequestDto> {
    if (senderId === receiverId) {
      throw errors.invalidAction('You cannot add yourself.');
    }

    const receiver = await userRepository.findById(receiverId);
    if (!receiver) throw errors.notFound('That player no longer exists.');

    // Deliberately the same refusal whichever direction the block runs in. A
    // distinct "they blocked you" message would tell the blocked party exactly
    // what the brief says not to reveal, and a blocker does not need to be
    // reminded of their own block to understand why this failed.
    if (await blockRepository.existsBetween(senderId, receiverId)) {
      throw errors.invalidAction('You cannot send a request to that player.');
    }

    if (await friendRepository.areFriends(senderId, receiverId)) {
      throw errors.invalidAction('You are already friends.');
    }

    const pending = await friendRepository.findPendingBetween(senderId, receiverId);
    if (pending) {
      throw errors.invalidAction(
        String(pending.senderId) === senderId
          ? 'You have already asked that player.'
          : 'That player has already asked you. Check your requests.',
      );
    }

    const sender = await userRepository.findById(senderId);
    if (!sender) throw errors.auth('That account no longer exists.');

    try {
      const created = await friendRepository.createRequest(senderId, receiverId);

      notifyFriendEvent(receiverId, 'requestReceived', {
        requestId: String(created._id),
        user: toUserSummary(sender as RankableUser),
      });

      // The durable half of the same nudge. The friend event tells an open
      // friends screen its list is stale; this is what the receiver finds
      // waiting if they were not connected at all. Not awaited: the request
      // has already been written, and a notification is never worth failing
      // it for.
      void notificationService.notify({
        userId: receiverId,
        type: NOTIFICATION_TYPE.friendRequest,
        title: 'New friend request',
        body: `${sender.username} wants to be your friend.`,
        actorId: senderId,
        data: { requestId: String(created._id) },
      });

      logger.info('friend request sent', { senderId, receiverId });

      return {
        id: String(created._id),
        status: FRIEND_REQUEST_STATUS.pending,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        user: toUserSummary(receiver as RankableUser),
      };
    } catch (error) {
      // The index caught a request the read above could not see, which means
      // somebody asked in the other direction a moment ago.
      if (isDuplicateKeyError(error)) {
        throw errors.invalidAction('There is already a request between you two.');
      }
      throw error;
    }
  }

  // ------------------------------------------------------------- resolving --

  /**
   * Accepts a request.
   *
   * Only the receiver may accept, which is checked against the row rather than
   * against anything the caller sent: a request id is not a capability, and
   * guessing one must not let a third party create a friendship between two
   * other people.
   */
  async accept(userId: string, requestId: string): Promise<{ friend: UserSummaryDto }> {
    const request = await this.requireOpenRequest(requestId);
    const senderId = String(request.senderId);

    if (String(request.receiverId) !== userId) {
      throw errors.notMember('That request is not yours to accept.');
    }

    // A block placed after the request was sent must win. Accepting into a
    // block would create exactly the friendship the block exists to prevent.
    if (await blockRepository.existsBetween(userId, senderId)) {
      await friendRepository.resolveRequest(requestId, FRIEND_REQUEST_STATUS.cancelled);
      throw errors.invalidAction('That request is no longer available.');
    }

    const sender = await userRepository.findById(senderId);
    if (!sender) {
      await friendRepository.resolveRequest(requestId, FRIEND_REQUEST_STATUS.cancelled);
      throw errors.notFound('That player no longer exists.');
    }

    // Flip the request first. It is the row with the concurrency guard on it,
    // so losing this step means another tap already handled the request and
    // there is nothing left to do. Creating the friendship first would let a
    // double-tap insert a friendship for a request that was being cancelled.
    const moved = await friendRepository.resolveRequest(requestId, FRIEND_REQUEST_STATUS.accepted);
    if (!moved) throw errors.invalidAction('That request has already been handled.');

    await friendRepository.createFriendship(userId, senderId, requestId);

    const receiver = await userRepository.findById(userId);

    notifyFriendEvent(senderId, 'requestAccepted', {
      requestId,
      user: receiver ? toUserSummary(receiver as RankableUser) : { id: userId, username: '', avatarId: 0, avatarColorIndex: 0 },
    });

    if (receiver) {
      void notificationService.notify({
        userId: senderId,
        type: NOTIFICATION_TYPE.friendRequestAccepted,
        title: 'Request accepted',
        body: `${receiver.username} accepted your friend request.`,
        actorId: userId,
        data: { requestId, friendId: userId },
      });
    }

    logger.info('friend request accepted', { userId, senderId });

    return { friend: toUserSummary(sender as RankableUser) };
  }

  /** Rejects a request. Receiver only. */
  async reject(userId: string, requestId: string): Promise<void> {
    const request = await this.requireOpenRequest(requestId);

    if (String(request.receiverId) !== userId) {
      throw errors.notMember('That request is not yours to reject.');
    }

    const moved = await friendRepository.resolveRequest(requestId, FRIEND_REQUEST_STATUS.rejected);
    if (!moved) throw errors.invalidAction('That request has already been handled.');

    // The sender is told their request was closed, but not by whom it was
    // read or when: the event carries the id and the actor's public card only.
    const receiver = await userRepository.findById(userId);
    notifyFriendEvent(String(request.senderId), 'requestRejected', {
      requestId,
      user: receiver ? toUserSummary(receiver as RankableUser) : null,
    });

    logger.info('friend request rejected', { userId, requestId });
  }

  /** Withdraws a request. Sender only. */
  async cancel(userId: string, requestId: string): Promise<void> {
    const request = await this.requireOpenRequest(requestId);

    if (String(request.senderId) !== userId) {
      throw errors.notMember('That request is not yours to cancel.');
    }

    const moved = await friendRepository.resolveRequest(requestId, FRIEND_REQUEST_STATUS.cancelled);
    if (!moved) throw errors.invalidAction('That request has already been handled.');

    notifyFriendEvent(String(request.receiverId), 'requestCancelled', { requestId });

    logger.info('friend request cancelled', { userId, requestId });
  }

  // --------------------------------------------------------------- lists --

  async listIncoming(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      friendRepository.listIncoming(userId, limit, skip),
      friendRepository.countIncoming(userId),
    ]);

    // The *sender* is the interesting party on an incoming request.
    const items = await this.hydrateRequests(rows, (row) => String(row.senderId));
    return { items, total, page, limit, hasMore: skip + items.length < total };
  }

  async listOutgoing(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      friendRepository.listOutgoing(userId, limit, skip),
      friendRepository.countOutgoing(userId),
    ]);

    const items = await this.hydrateRequests(rows, (row) => String(row.receiverId));
    return { items, total, page, limit, hasMore: skip + items.length < total };
  }

  /** The caller's accepted friends, most recently added first. */
  async listFriends(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const [pairs, total] = await Promise.all([
      friendRepository.listFriendships(userId, limit, skip),
      friendRepository.countFriends(userId),
    ]);

    const sinceById = new Map<string, number>();
    for (const pair of pairs) {
      const otherId =
        String(pair.userAId) === userId ? String(pair.userBId) : String(pair.userAId);
      sinceById.set(otherId, new Date(pair.createdAt ?? Date.now()).getTime());
    }

    const users = await userRepository.findManyByIds([...sinceById.keys()]);

    const items: FriendDto[] = users.map((user) => {
      const row = user as RankableUser;
      const id = String(row._id);
      return {
        ...toUserSummary(row),
        ...toUserStats(row),
        friendsSinceMs: sinceById.get(id) ?? 0,
        lastSeenAtMs: new Date(row.lastSeenAt ?? Date.now()).getTime(),
      };
    });

    // `findManyByIds` returns rows in whatever order the `$in` produced, so the
    // "most recently added" ordering is restored here rather than assumed.
    items.sort((a, b) => b.friendsSinceMs - a.friendsSinceMs);

    return { items, total, page, limit, hasMore: skip + items.length < total };
  }

  // ------------------------------------------------------------- removal --

  /**
   * Ends a friendship.
   *
   * Symmetric by construction — there is one row for the pair, so removing it
   * removes the friendship for both people at once and cannot leave one of
   * them still seeing the other. Past requests are left alone: they are
   * history, and deleting them would also delete the record of who asked whom.
   */
  async removeFriend(userId: string, friendId: string): Promise<void> {
    if (userId === friendId) throw errors.invalidAction('You cannot unfriend yourself.');

    const removed = await friendRepository.removeFriendship(userId, friendId);
    if (!removed) throw errors.notFound('You are not friends with that player.');

    const actor = await userRepository.findById(userId);
    notifyFriendEvent(friendId, 'removed', {
      user: actor ? toUserSummary(actor as RankableUser) : { id: userId },
    });

    logger.info('friendship removed', { userId, friendId });
  }

  // ------------------------------------------------------------ relation --

  /**
   * How [viewerId] stands relative to [otherId].
   *
   * The single value the client's profile button is driven from. Computed here
   * because it is a permission in disguise: a client that decided for itself
   * that it was friends with somebody would be deciding what it is allowed to
   * do to them.
   *
   * Being blocked *by* the other party is reported as `none`, not as
   * `blocked_by`. A blocked user sees a profile that looks exactly like a
   * stranger's, and their "Add friend" tap is refused by `sendRequest` with a
   * message that does not say why.
   */
  async relation(
    viewerId: string,
    otherId: string,
  ): Promise<{ relation: RelationWire; pendingRequestId: string | null }> {
    if (viewerId === otherId) return { relation: RELATION.self, pendingRequestId: null };

    const { aBlockedB, bBlockedA } = await blockRepository.directionsBetween(viewerId, otherId);

    if (aBlockedB) return { relation: RELATION.blocked, pendingRequestId: null };
    if (bBlockedA) return { relation: RELATION.none, pendingRequestId: null };

    if (await friendRepository.areFriends(viewerId, otherId)) {
      return { relation: RELATION.friends, pendingRequestId: null };
    }

    const pending = await friendRepository.findPendingBetween(viewerId, otherId);
    if (!pending) return { relation: RELATION.none, pendingRequestId: null };

    return {
      relation:
        String(pending.senderId) === viewerId ? RELATION.requestSent : RELATION.requestReceived,
      pendingRequestId: String(pending._id),
    };
  }

  // ------------------------------------------------------------- internal --

  /** Loads a request, refusing anything that is not still open. */
  private async requireOpenRequest(requestId: string) {
    const request = await friendRepository.findRequestById(requestId);
    if (!request) throw errors.notFound('That request no longer exists.');

    if (request.status !== FRIEND_REQUEST_STATUS.pending) {
      throw errors.invalidAction('That request has already been handled.');
    }

    return request;
  }

  /**
   * Attaches the other party's profile to a page of requests.
   *
   * One `$in` for the whole page rather than a lookup per row: twenty-five
   * requests would otherwise be twenty-five round trips. A request whose
   * counterpart has since been deleted is dropped from the page instead of
   * being rendered as a blank row — there is nobody left to accept.
   */
  private async hydrateRequests(
    rows: { _id: unknown; status: string; createdAt?: Date | null; updatedAt?: Date | null; senderId: unknown; receiverId: unknown }[],
    otherIdOf: (row: { senderId: unknown; receiverId: unknown }) => string,
  ): Promise<FriendRequestDto[]> {
    if (rows.length === 0) return [];

    const users = await userRepository.findManyByIds(rows.map(otherIdOf));
    const byId = new Map(users.map((user) => [String(user._id), user as RankableUser]));

    const items: FriendRequestDto[] = [];
    for (const row of rows) {
      const other = byId.get(otherIdOf(row));
      if (!other) continue;

      items.push({
        id: String(row._id),
        status: FRIEND_REQUEST_STATUS.pending,
        createdAtMs: new Date(row.createdAt ?? Date.now()).getTime(),
        updatedAtMs: new Date(row.updatedAt ?? Date.now()).getTime(),
        user: toUserSummary(other),
      });
    }

    return items;
  }
}

/** Normalises a page request for the list endpoints in this service. */
export function listPaging(input: { page?: number; limit?: number }): {
  page: number;
  limit: number;
} {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? PAGE_LIMITS.defaultLimit), 1),
    PAGE_LIMITS.maxLimit,
  );
  const page = Math.max(Math.trunc(input.page ?? 1), 1);

  if (page > PAGE_LIMITS.maxPage) {
    throw errors.validation(`Pages stop at ${PAGE_LIMITS.maxPage}.`);
  }

  return { page, limit };
}

export const friendService = new FriendService();
