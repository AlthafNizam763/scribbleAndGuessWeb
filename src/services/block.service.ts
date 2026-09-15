import { PAGE_LIMITS } from '@/constants/social.constants';
import { blockRepository } from '@/repositories/block.repository';
import { invitationRepository } from '@/repositories/invitation.repository';
import { friendRepository } from '@/repositories/friend.repository';
import { userRepository } from '@/repositories/user.repository';
import { toUserSummary, type RankableUser } from '@/services/profile.serialize';
import { notifyFriendEvent } from '@/services/social.notify';
import type { BlockDto } from '@/types/social.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Blocking and unblocking.
 *
 * ## Why this is its own service
 *
 * Blocking is not a friend operation that happens to tear down a friendship —
 * it is a standing instruction that outlives every friendship, request and
 * room the two people ever share. Keeping it separate is also what keeps the
 * dependency graph acyclic: this service reaches into the friend *repository*
 * to clean up, and `friend.service.ts` reaches into the block *repository* to
 * check, so neither service imports the other.
 *
 * ## The cascade, and why it runs in this order
 *
 * Placing a block records it first and cleans up second. A cleanup that ran
 * first would leave a window in which the friendship was already gone but
 * nothing was stopping a fresh request from arriving. With the row written
 * first, every gate — `sendRequest`, `accept`, matchmaking, search — is
 * already refusing before anything is torn down.
 *
 * ## What the blocked user learns
 *
 * Nothing. No event is sent to them, their profile keeps rendering as a
 * stranger's rather than as "blocked", and their attempt to send a request is
 * refused with a message that does not say why (brief: "do not reveal
 * unnecessary block details to the blocked user"). The one thing they can
 * observe is that a friendship ended — which is unavoidable, because the
 * friend simply is not in their list any more, and leaving a ghost row there
 * would be worse than the inference.
 *
 * ## Unblocking restores nothing
 *
 * Lifting a block lets the two interact again under the ordinary rules. It
 * does not bring back the friendship it destroyed, and it does not reopen the
 * requests it cancelled: both were resolved, and quietly resurrecting a
 * friendship somebody deliberately ended would be the opposite of what they
 * asked for. They have to ask again.
 */

export class BlockService {
  /** Blocks [targetId] on behalf of [blockerId], and tears down what exists. */
  async block(blockerId: string, targetId: string): Promise<{ blocked: BlockDto }> {
    if (blockerId === targetId) {
      throw errors.invalidAction('You cannot block yourself.');
    }

    const target = await userRepository.findById(targetId);
    if (!target) throw errors.notFound('That player no longer exists.');

    const created = await blockRepository.create(blockerId, targetId);

    if (created) {
      // Both directions at once. After a block there must be no open request
      // between the two, whoever sent it.
      const cancelled = await friendRepository.cancelPendingBetween(blockerId, targetId);
      const unfriended = await friendRepository.removeFriendship(blockerId, targetId);

      // And any room invitation still open between them, in either direction.
      // An invitation that outlived the relationship it was sent on is exactly
      // what a block exists to prevent — and `invite` already refuses a
      // blocked target, so leaving the old row pending would be the one way
      // around that check.
      const invitations = await invitationRepository.expireBetween(blockerId, targetId);

      if (unfriended) {
        // The only push the blocked party gets, and it says nothing about the
        // block: their friend list changed, which they can see for themselves.
        notifyFriendEvent(targetId, 'removed', { user: { id: blockerId } });
      }

      logger.info('user blocked', {
        blockerId,
        targetId,
        cancelled,
        unfriended,
        invitations,
      });
    }

    // Sent to the blocker only. This is what refreshes *their* lists.
    notifyFriendEvent(blockerId, 'blocked', {
      user: toUserSummary(target as RankableUser),
    });

    return {
      blocked: {
        ...toUserSummary(target as RankableUser),
        blockedAtMs: Date.now(),
      },
    };
  }

  /** Lifts a block. Does not restore the friendship it ended. */
  async unblock(blockerId: string, targetId: string): Promise<void> {
    const removed = await blockRepository.remove(blockerId, targetId);
    if (!removed) throw errors.notFound('That player is not blocked.');

    notifyFriendEvent(blockerId, 'unblocked', { user: { id: targetId } });

    logger.info('user unblocked', { blockerId, targetId });
  }

  /** Who the caller has blocked. Only ever their own list. */
  async list(blockerId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      blockRepository.list(blockerId, limit, skip),
      blockRepository.count(blockerId),
    ]);

    const blockedAtById = new Map<string, number>(
      rows.map((row) => [
        String(row.blockedUserId),
        new Date(row.createdAt ?? Date.now()).getTime(),
      ]),
    );

    const users = await userRepository.findManyByIds([...blockedAtById.keys()]);

    const items: BlockDto[] = users.map((user) => ({
      ...toUserSummary(user as RankableUser),
      blockedAtMs: blockedAtById.get(String(user._id)) ?? 0,
    }));

    // Restores "most recently blocked first" after the `$in` returned rows in
    // its own order.
    items.sort((a, b) => b.blockedAtMs - a.blockedAtMs);

    return { items, total, page, limit, hasMore: skip + items.length < total };
  }

  /** Whether a block stands between two users, in either direction. */
  async blocksBetween(a: string, b: string): Promise<boolean> {
    return blockRepository.existsBetween(a, b);
  }
}

/** Normalises a page request for the block list. */
export function blockPaging(input: { page?: number; limit?: number }): {
  page: number;
  limit: number;
} {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? PAGE_LIMITS.defaultLimit), 1),
    PAGE_LIMITS.maxLimit,
  );
  return { page: Math.max(Math.trunc(input.page ?? 1), 1), limit };
}

export const blockService = new BlockService();
