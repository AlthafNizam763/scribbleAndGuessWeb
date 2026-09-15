import { LEADERBOARD_SCOPE, PAGE_LIMITS, type LeaderboardScope } from '@/constants/social.constants';
import { blockRepository } from '@/repositories/block.repository';
import { friendRepository } from '@/repositories/friend.repository';
import { userRepository } from '@/repositories/user.repository';
import { toLeaderboardRow, toLocality, type RankableUser } from '@/services/profile.serialize';
import type { LeaderboardPageDto, LeaderboardRowDto, LocalityDto } from '@/types/social.types';
import { errors } from '@/utils/errors';

/**
 * The leaderboards: world, friends and locality.
 *
 * ## Ranking, and why it is not stored
 *
 * Rank is `totalScore` descending, `gamesWon` descending, then `_id`
 * ascending, and it is derived on every read. A stored rank would be stale for
 * every player but one the moment anybody finished a game, and keeping it
 * fresh would mean rewriting the collection after every match. Counting the
 * rows above a player instead is one indexed count against the same compound
 * index the page itself is sorted by.
 *
 * The `_id` tie-break is what makes the order *total* rather than merely
 * mostly-determined. Two players on identical score and wins would otherwise
 * come back in whatever order the storage engine felt like, so a refresh would
 * shuffle them and the board would look broken while nothing had changed.
 *
 * ## Scores come from the game engine only
 *
 * Nothing in this file writes. Every number it reads was put on the user row
 * by `userRepository.recordGameResult`, which only the server-side end-of-match
 * path calls. There is no code path from a request body to a score.
 *
 * ## Rank change
 *
 * Every row carries `rankChange`, and it is always `null` today. Nothing in
 * this database records what anybody's rank *was* — there is no ranking
 * history collection and no snapshot job — and a movement arrow computed from
 * no history would be a number the server made up. The field is on the wire
 * so that adding a nightly snapshot later is a change to this service and to
 * nothing else: no client would need a new build to start showing arrows.
 *
 * ## Paging
 *
 * Skip-based, with `page` hard-capped by `PAGE_LIMITS.maxPage`. A skip is
 * `O(skip)` in Mongo, so an uncapped page number is a way to make the server
 * do arbitrary work for one request; past the cap the request is refused
 * rather than clamped, because silently serving page 400 when page 40000 was
 * asked for looks like missing data.
 */

/** What every scope's handler is given after validation. */
export interface LeaderboardQuery {
  /** The caller, or null on an anonymous read of the world board. */
  viewerId: string | null;
  page: number;
  limit: number;
}

export class LeaderboardService {
  // ---------------------------------------------------------------- world --

  /**
   * Everybody who has finished at least one game.
   *
   * Readable without a token — the board is public, and requiring one would
   * mean a first run could not show it. A caller who *is* signed in also gets
   * their own rank and row, which is the number they came for and which would
   * otherwise cost a second request and a client-side scan of a page they are
   * probably not on.
   */
  async world(query: LeaderboardQuery): Promise<LeaderboardPageDto> {
    const { page, limit, skip } = paging(query);

    // Anonymous callers have nobody blocked, so the exclusion set is empty and
    // the query is the plain ranked one.
    const hidden = query.viewerId ? await blockRepository.relatedIds(query.viewerId) : [];

    const [rows, total] = await Promise.all([
      userRepository.leaderboard(limit, skip, hidden),
      userRepository.countRanked(hidden),
    ]);

    return this.page({
      scope: LEADERBOARD_SCOPE.world,
      rows: rows as RankableUser[],
      total,
      page,
      limit,
      skip,
      viewerId: query.viewerId,
      selfRank: () => this.rankOf(query.viewerId, { excludeIds: hidden }),
    });
  }

  // -------------------------------------------------------------- friends --

  /**
   * The caller and their accepted friends, ranked among themselves.
   *
   * The caller is always in the list, even on zero games: a friends board that
   * does not include you cannot answer the only question anyone asks of it.
   * For the same reason the `gamesPlayed > 0` rule that governs the world
   * board is not applied here — a friend who has not played yet belongs in a
   * list of your friends, on zero, rather than disappearing from it.
   *
   * Blocked users cannot be friends (blocking removes the friendship), so no
   * separate exclusion is needed.
   */
  async friends(query: LeaderboardQuery): Promise<LeaderboardPageDto> {
    const viewerId = this.requireViewer(query.viewerId);
    const { page, limit, skip } = paging(query);

    const ids = [...new Set([viewerId, ...(await friendRepository.friendIdsOf(viewerId))])];

    const [rows, total] = await Promise.all([
      userRepository.leaderboardForIds(ids, limit, skip),
      userRepository.countForIds(ids),
    ]);

    return this.page({
      scope: LEADERBOARD_SCOPE.friends,
      rows: rows as RankableUser[],
      total,
      page,
      limit,
      skip,
      viewerId,
      selfRank: () => this.rankOf(viewerId, { ids }),
    });
  }

  // ------------------------------------------------------------- locality --

  /**
   * Players from the caller's own town.
   *
   * Grouped by `localityKey`, a normalised `country|region|city` string
   * derived from the profile fields — never by a coordinate, and never by
   * anything finer than a town. A caller who has not set a city gets an empty
   * page with `locality: null`, which is what the client renders as the
   * "complete your profile" prompt rather than as an error.
   */
  async locality(query: LeaderboardQuery): Promise<LeaderboardPageDto> {
    const viewerId = this.requireViewer(query.viewerId);
    const { page, limit, skip } = paging(query);

    const viewer = await userRepository.findById(viewerId);
    if (!viewer) throw errors.auth('That account no longer exists.');

    const localityKey = viewer.localityKey ?? null;
    const locality = toLocality(viewer as RankableUser);

    if (!localityKey) {
      return {
        scope: LEADERBOARD_SCOPE.locality,
        items: [],
        currentUserRank: null,
        currentUserEntry: null,
        total: 0,
        page,
        limit,
        hasMore: false,
        locality: null,
      };
    }

    const hidden = await blockRepository.relatedIds(viewerId);

    const [rows, total] = await Promise.all([
      userRepository.leaderboardForLocality(localityKey, limit, skip, hidden),
      userRepository.countForLocality(localityKey, hidden),
    ]);

    const result = await this.page({
      scope: LEADERBOARD_SCOPE.locality,
      rows: rows as RankableUser[],
      total,
      page,
      limit,
      skip,
      viewerId,
      includeLocality: true,
      selfRank: () => this.rankOf(viewerId, { localityKey, excludeIds: hidden }),
    });

    return { ...result, locality };
  }

  // ------------------------------------------------------------ self rank --

  /**
   * The caller's rank in one scope, without a page of rows.
   *
   * Serves `GET /api/leaderboard/me/rank`, and is what lets a client pin
   * "you are 4,212th" above a board the player is nowhere near.
   */
  async myRank(
    viewerId: string,
    scope: LeaderboardScope,
  ): Promise<{ scope: LeaderboardScope; rank: number | null; total: number; entry: LeaderboardRowDto | null; locality: LocalityDto | null }> {
    const user = await userRepository.findById(viewerId);
    if (!user) throw errors.auth('That account no longer exists.');

    const row = user as RankableUser;

    if (scope === LEADERBOARD_SCOPE.friends) {
      const ids = [...new Set([viewerId, ...(await friendRepository.friendIdsOf(viewerId))])];
      const [rank, total] = await Promise.all([
        userRepository.rankAbove(reference(row), { ids }),
        userRepository.countForIds(ids),
      ]);
      return {
        scope,
        rank: rank + 1,
        total,
        entry: toLeaderboardRow(row, { rank: rank + 1, selfId: viewerId }),
        locality: null,
      };
    }

    const hidden = await blockRepository.relatedIds(viewerId);

    if (scope === LEADERBOARD_SCOPE.locality) {
      const localityKey = user.localityKey ?? null;
      if (!localityKey) {
        return { scope, rank: null, total: 0, entry: null, locality: null };
      }

      const [rank, total] = await Promise.all([
        userRepository.rankAbove(reference(row), { localityKey, excludeIds: hidden }),
        userRepository.countForLocality(localityKey, hidden),
      ]);

      // Unranked in a scope the caller is not eligible for, rather than "1st".
      const eligible = user.gamesPlayed > 0;

      return {
        scope,
        rank: eligible ? rank + 1 : null,
        total,
        entry: eligible
          ? toLeaderboardRow(row, { rank: rank + 1, selfId: viewerId, includeLocality: true })
          : null,
        locality: toLocality(row),
      };
    }

    const eligible = user.gamesPlayed > 0;
    const [rank, total] = await Promise.all([
      userRepository.rankAbove(reference(row), { excludeIds: hidden }),
      userRepository.countRanked(hidden),
    ]);

    return {
      scope: LEADERBOARD_SCOPE.world,
      rank: eligible ? rank + 1 : null,
      total,
      entry: eligible ? toLeaderboardRow(row, { rank: rank + 1, selfId: viewerId }) : null,
      locality: null,
    };
  }

  /**
   * The world rank of any user, for their profile card.
   *
   * Null when they have never finished a game, which is the same eligibility
   * rule the world board itself applies.
   */
  async worldRankOf(user: RankableUser): Promise<number | null> {
    if (user.gamesPlayed <= 0) return null;
    return (await userRepository.rankAbove(reference(user))) + 1;
  }

  // -------------------------------------------------------------- internal --

  private requireViewer(viewerId: string | null): string {
    if (!viewerId) throw errors.auth('Sign in to see that leaderboard.');
    return viewerId;
  }

  /** The caller's absolute rank in a scope, or null when they are unranked. */
  private async rankOf(
    viewerId: string | null,
    scope: { localityKey?: string; ids?: string[]; excludeIds?: string[] },
  ): Promise<{ rank: number | null; row: RankableUser | null }> {
    if (!viewerId) return { rank: null, row: null };

    const user = await userRepository.findById(viewerId);
    if (!user) return { rank: null, row: null };

    const row = user as RankableUser;

    // The friends scope has no eligibility rule — you are on your own friends
    // board whatever you have played — so only the other two check it.
    const eligibilityApplies = scope.ids === undefined;
    if (eligibilityApplies && user.gamesPlayed <= 0) return { rank: null, row };

    const above = await userRepository.rankAbove(reference(row), scope);
    return { rank: above + 1, row };
  }

  /**
   * Assembles a page, and pins the caller's own row to it.
   *
   * `currentUserEntry` is filled in even when the caller is far outside the
   * page. That is the whole reason the rank is computed separately rather than
   * read off the page: a player on page 400 still wants to see where they
   * stand without paging there, and the client draws that row in a pinned
   * footer.
   */
  private async page(input: {
    scope: LeaderboardScope;
    rows: RankableUser[];
    total: number;
    page: number;
    limit: number;
    skip: number;
    viewerId: string | null;
    includeLocality?: boolean;
    selfRank: () => Promise<{ rank: number | null; row: RankableUser | null }>;
  }): Promise<LeaderboardPageDto> {
    const seen = new Set<string>();
    const items: LeaderboardRowDto[] = [];

    input.rows.forEach((row, index) => {
      const id = String(row._id);
      // A page cannot legitimately repeat a user, but an id set assembled from
      // two sources (friends plus the caller) could, and a duplicated row
      // would take a rank number away from whoever should have had it.
      if (seen.has(id)) return;
      seen.add(id);

      items.push(
        toLeaderboardRow(row, {
          rank: input.skip + index + 1,
          selfId: input.viewerId,
          includeLocality: input.includeLocality,
        }),
      );
    });

    const { rank, row } = await input.selfRank();

    const onPage = input.viewerId === null ? null : items.find((item) => item.isSelf) ?? null;

    return {
      scope: input.scope,
      items,
      currentUserRank: rank,
      currentUserEntry:
        onPage ??
        (row !== null && rank !== null
          ? toLeaderboardRow(row, {
              rank,
              selfId: input.viewerId,
              includeLocality: input.includeLocality,
            })
          : null),
      total: input.total,
      page: input.page,
      limit: input.limit,
      hasMore: input.skip + items.length < input.total,
    };
  }
}

/** The three fields `rankAbove` compares against, pulled off a row. */
function reference(user: RankableUser): { totalScore: number; gamesWon: number; id: string } {
  return { totalScore: user.totalScore, gamesWon: user.gamesWon, id: String(user._id) };
}

/** Validates and normalises paging, refusing a page past the depth cap. */
export function paging(query: { page: number; limit: number }): {
  page: number;
  limit: number;
  skip: number;
} {
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), PAGE_LIMITS.maxLimit);
  const page = Math.max(Math.trunc(query.page), 1);

  if (page > PAGE_LIMITS.maxPage) {
    throw errors.validation(`Pages stop at ${PAGE_LIMITS.maxPage}. Narrow the list instead.`);
  }

  return { page, limit, skip: (page - 1) * limit };
}

export const leaderboardService = new LeaderboardService();
