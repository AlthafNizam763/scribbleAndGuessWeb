import { Types } from 'mongoose';

import { Block, type BlockDocument } from '@/models/Block';
import { isObjectId } from '@/repositories/user.repository';
import { TtlCache } from '@/utils/ttlCache';

/**
 * Data access for `blocks`.
 *
 * ## Why almost every read here is bidirectional
 *
 * A block is stored in one direction but has to *bite* in both. The person who
 * blocked must not see the other in search or on a leaderboard; the person who
 * was blocked must not be able to send them a request, and must not learn that
 * any of this happened. So the common question is not "did A block B" but "is
 * there a block between A and B at all", and that is what `existsBetween`
 * answers in a single indexed query.
 */

const asId = (value: string): Types.ObjectId => new Types.ObjectId(value);

/**
 * `relatedIds` results, briefly cached (brief section 10).
 *
 * ## Why this one read and not the others
 *
 * `relatedIds` is the most frequently repeated query in the app that does not
 * have to be fresh. Quick Play calls it, the public-room browser calls it on
 * every pull to refresh, and search and the leaderboards call it too — so a
 * hundred players idling on the room list are running a hundred of these a
 * second between them, all returning the same handful of ids, all of which
 * change only when somebody taps Block.
 *
 * ## Why thirty seconds, and why staleness is safe here
 *
 * The window is short enough that a block takes effect on the next screen the
 * blocker looks at, and every mutation below invalidates both parties anyway,
 * so the stale window in practice only covers a block placed by a *third*
 * process. What a stale entry can cost is bounded: a blocked pair briefly
 * visible to each other in a room list. It cannot seat them together — the
 * join path re-checks — and it cannot leak anything, because the list row
 * carries only a host name and an occupancy count.
 *
 * Deliberately not cached: `existsBetween` and `directionsBetween`. Those gate
 * *actions* — sending a request, accepting an invitation — where a stale
 * "false" would let through the one interaction the block exists to prevent.
 */
const relatedIdsCache = new TtlCache<string[]>({ ttlMs: 30_000, maxEntries: 5_000 });

/**
 * Forgets both sides of a block.
 *
 * Both, because the relationship is symmetric for every caller of
 * `relatedIds`: blocking somebody removes them from your lists and you from
 * theirs, so caching only the actor's view would leave the other party seeing
 * a room they can no longer be seated in.
 */
function forgetRelated(a: string, b: string): void {
  relatedIdsCache.invalidateAll([a, b]);
}

/** Empties the block caches. Used by tests. */
export function resetBlockCaches(): void {
  relatedIdsCache.clear();
}

export const blockRepository = {
  /**
   * Records a block, or does nothing when it is already recorded.
   *
   * Returns whether this call was the one that created it, which is what lets
   * the service skip the cascade — tearing down a friendship, cancelling
   * requests — on a repeated tap.
   */
  async create(blockerId: string, blockedUserId: string): Promise<boolean> {
    if (!isObjectId(blockerId) || !isObjectId(blockedUserId)) return false;

    const result = await Block.updateOne(
      { blockerId: asId(blockerId), blockedUserId: asId(blockedUserId) },
      {
        $setOnInsert: {
          blockerId: asId(blockerId),
          blockedUserId: asId(blockedUserId),
        },
      },
      { upsert: true },
    ).exec();

    const created = result.upsertedCount === 1;
    if (created) forgetRelated(blockerId, blockedUserId);
    return created;
  },

  async remove(blockerId: string, blockedUserId: string): Promise<boolean> {
    if (!isObjectId(blockerId) || !isObjectId(blockedUserId)) return false;

    const result = await Block.deleteOne({
      blockerId: asId(blockerId),
      blockedUserId: asId(blockedUserId),
    }).exec();

    const removed = result.deletedCount === 1;
    if (removed) forgetRelated(blockerId, blockedUserId);
    return removed;
  },

  /** Whether this exact block exists. Only the blocker is ever told this. */
  async exists(blockerId: string, blockedUserId: string): Promise<boolean> {
    if (!isObjectId(blockerId) || !isObjectId(blockedUserId)) return false;
    return (
      (await Block.exists({
        blockerId: asId(blockerId),
        blockedUserId: asId(blockedUserId),
      }).exec()) !== null
    );
  },

  /**
   * Which directions a block exists in between two users.
   *
   * One query for both, because every caller needs both answers and two
   * queries would be two round trips for a fact the same index already holds.
   */
  async directionsBetween(
    a: string,
    b: string,
  ): Promise<{ aBlockedB: boolean; bBlockedA: boolean }> {
    if (!isObjectId(a) || !isObjectId(b)) return { aBlockedB: false, bBlockedA: false };

    const rows = await Block.find({
      $or: [
        { blockerId: asId(a), blockedUserId: asId(b) },
        { blockerId: asId(b), blockedUserId: asId(a) },
      ],
    })
      .select('blockerId')
      .lean()
      .exec();

    return {
      aBlockedB: rows.some((row: Pick<BlockDocument, 'blockerId'>) => String(row.blockerId) === a),
      bBlockedA: rows.some((row: Pick<BlockDocument, 'blockerId'>) => String(row.blockerId) === b),
    };
  },

  /** Whether a block exists in either direction. The usual gate. */
  async existsBetween(a: string, b: string): Promise<boolean> {
    const { aBlockedB, bBlockedA } = await this.directionsBetween(a, b);
    return aBlockedB || bBlockedA;
  },

  /**
   * Every user id this user cannot interact with, in either direction.
   *
   * This is the exclusion set for search, for leaderboards and for Quick Play
   * matchmaking. It is loaded whole rather than paged because it is small —
   * blocking is rare — and because it is used as an `$nin`, which needs the
   * full set to be correct. A user with an implausibly long list would still
   * only be paying for one indexed query of small documents.
   *
   * Briefly cached — see `relatedIdsCache`. The query below is what runs on a
   * miss, unchanged.
   */
  async relatedIds(userId: string): Promise<string[]> {
    if (!isObjectId(userId)) return [];

    return relatedIdsCache.remember(userId, async () => {
      const id = asId(userId);
      const rows = await Block.find({ $or: [{ blockerId: id }, { blockedUserId: id }] })
        .select('blockerId blockedUserId')
        .lean()
        .exec();

      const ids = new Set<string>();
      for (const row of rows as Pick<BlockDocument, 'blockerId' | 'blockedUserId'>[]) {
        const other =
          String(row.blockerId) === userId ? String(row.blockedUserId) : String(row.blockerId);
        ids.add(other);
      }

      return [...ids];
    });
  },

  /** "Who have I blocked", newest first. */
  async list(blockerId: string, limit: number, skip: number) {
    if (!isObjectId(blockerId)) return [];
    return Block.find({ blockerId: asId(blockerId) })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  async count(blockerId: string): Promise<number> {
    if (!isObjectId(blockerId)) return 0;
    return Block.countDocuments({ blockerId: asId(blockerId) }).exec();
  },
};
