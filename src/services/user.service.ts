import { INPUT_LIMITS } from '@/constants/game.constants';
import {
  PAGE_LIMITS,
  RELATION,
  SEARCH_LIMITS,
  type RelationWire,
} from '@/constants/social.constants';
import { blockRepository } from '@/repositories/block.repository';
import { friendRepository } from '@/repositories/friend.repository';
import { userRepository } from '@/repositories/user.repository';
import { sanitizeUsername } from '@/services/auth.service';
import { friendService } from '@/services/friend.service';
import { leaderboardService } from '@/services/leaderboard.service';
import {
  toLocality,
  toUserStats,
  toUserSummary,
  type RankableUser,
} from '@/services/profile.serialize';
import type {
  LocalityDto,
  PublicProfileDto,
  UserStatsDto,
  UserSummaryDto,
} from '@/types/social.types';
import { errors } from '@/utils/errors';

/**
 * Profiles (brief section 8).
 *
 * The whole point of this service is the shape of `updateProfile`: it accepts
 * a name and an avatar and *nothing else*. Score, wins, games played and the
 * auth provider are not parameters, so there is no code path by which a
 * request body could reach them however it is spelled. Refusing them in a
 * validator would work too, but a validator can be bypassed by a future
 * caller; a function that cannot express the write cannot be.
 */

export interface PublicUser {
  id: string;
  username: string;
  avatarId: number;
  avatarColorIndex: number;
  authProvider: string;
  gamesPlayed: number;
  gamesWon: number;
  totalScore: number;
  bestRoundScore: number;
  createdAt: string;
  lastSeenAt: string;
  /**
   * Where this player plays from, or null when they have not said.
   *
   * Added to the existing shape rather than returned from a new endpoint: the
   * client needs it on the same read it already makes to draw the profile
   * screen, and a separate call for one optional field would be a round trip
   * per app launch. Every existing consumer ignores an unknown key, so nothing
   * that already reads this shape has to change.
   */
  locality: LocalityDto | null;
}

export class UserService {
  async me(userId: string): Promise<PublicUser> {
    const user = await userRepository.findById(userId);
    if (!user) throw errors.auth('That account no longer exists.');

    return {
      id: String(user._id),
      username: user.username,
      avatarId: user.avatarId,
      avatarColorIndex: user.avatarColorIndex,
      authProvider: user.authProvider,
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon,
      totalScore: user.totalScore,
      bestRoundScore: user.bestRoundScore,
      createdAt: new Date(user.createdAt ?? Date.now()).toISOString(),
      lastSeenAt: new Date(user.lastSeenAt ?? Date.now()).toISOString(),
      locality: toLocality(user as RankableUser),
    };
  }

  /** Updates the two fields a player owns. */
  async updateProfile(
    userId: string,
    patch: { username?: string; avatarId?: number; avatarColorIndex?: number },
  ): Promise<PublicUser> {
    const update: { username?: string; avatarId?: number; avatarColorIndex?: number } = {};

    if (patch.username !== undefined) update.username = sanitizeUsername(patch.username);

    if (patch.avatarId !== undefined) {
      update.avatarId = clamp(patch.avatarId, INPUT_LIMITS.avatarCount);
    }
    if (patch.avatarColorIndex !== undefined) {
      update.avatarColorIndex = clamp(patch.avatarColorIndex, INPUT_LIMITS.avatarColorCount);
    }

    if (Object.keys(update).length === 0) throw errors.validation('Nothing to update.');

    const updated = await userRepository.updateProfile(userId, update);
    if (!updated) throw errors.auth('That account no longer exists.');

    return this.me(userId);
  }

  /**
   * Sets where the player plays from, for the locality leaderboard.
   *
   * Separate from `updateProfile` for the same reason that one takes no
   * scores: the set of writable fields is the security boundary, and keeping
   * locality out of the profile patch means a body aimed at renaming somebody
   * cannot also move them into a town. Passing all three fields as null clears
   * the locality and drops the player off that board.
   *
   * Nothing finer than a town can be stored — see the note on the schema — so
   * there is no path from here to a street address whatever a client sends.
   */
  async updateLocality(
    userId: string,
    patch: { city: string | null; region: string | null; country: string | null },
  ): Promise<PublicUser> {
    const updated = await userRepository.updateLocality(userId, patch);
    if (!updated) throw errors.auth('That account no longer exists.');

    return this.me(userId);
  }

  /**
   * Another player's profile, as the caller is allowed to see it.
   *
   * Carries the public card, the lifetime stats, the world rank and — the part
   * the client actually needs — the caller's `relation` to them, which is what
   * the Add Friend / Friends / Blocked button is drawn from. Computing it here
   * rather than letting the client infer it from its own lists is what stops a
   * stale client offering an action the server would refuse.
   *
   * A profile is readable even when the subject has blocked the caller, and it
   * looks exactly like a stranger's: the relation comes back as `none` and
   * every action on it is refused without saying why.
   */
  async publicProfile(viewerId: string, targetId: string): Promise<PublicProfileDto> {
    const user = await userRepository.findById(targetId);
    if (!user) throw errors.notFound('That player no longer exists.');

    const row = user as RankableUser;

    const [{ relation, pendingRequestId }, rank] = await Promise.all([
      friendService.relation(viewerId, targetId),
      leaderboardService.worldRankOf(row),
    ]);

    return {
      ...toUserSummary(row),
      stats: toUserStats(row),
      locality: toLocality(row),
      rank,
      lastSeenAtMs: new Date(row.lastSeenAt ?? Date.now()).getTime(),
      createdAtMs: new Date(row.createdAt ?? Date.now()).getTime(),
      relation,
      pendingRequestId,
    };
  }

  /**
   * Finds players by the start of their name.
   *
   * The caller is excluded, and so is everybody a block stands between: a
   * blocked user is simply absent from the world, which is both what the
   * blocker asked for and what keeps the block from being discoverable by the
   * blocked party.
   *
   * Results carry each match's relation to the caller so the list can render
   * the right button per row without a request per result. That is `n + 3`
   * queries for a page rather than `3n`, and the three are the same ones the
   * profile screen makes.
   */
  async search(
    viewerId: string,
    term: string,
    limit: number,
  ): Promise<(UserSummaryDto & { stats: UserStatsDto; relation: RelationWire })[]> {
    const trimmed = term.trim();
    if (trimmed.length < SEARCH_LIMITS.minTermLength) {
      throw errors.validation(
        `Type at least ${SEARCH_LIMITS.minTermLength} characters to search.`,
      );
    }

    const hidden = [viewerId, ...(await blockRepository.relatedIds(viewerId))];
    const rows = await userRepository.searchByUsername(trimmed, limit, hidden);

    // Two set reads for the whole page instead of one relation lookup per row.
    const [friendIds, pendingByOther] = await Promise.all([
      friendRepository.friendIdsOf(viewerId).then((ids) => new Set(ids)),
      pendingRelationsOf(viewerId),
    ]);

    return rows.map((user) => {
      const row = user as RankableUser;
      const id = String(row._id);

      const relation: RelationWire = friendIds.has(id)
        ? RELATION.friends
        : (pendingByOther.get(id) ?? RELATION.none);

      return { ...toUserSummary(row), stats: toUserStats(row), relation };
    });
  }
}

/**
 * Every user the caller has an open request with, and which way it points.
 *
 * One query for the caller's whole pending set rather than one per search
 * result. The set is small by construction — a pending request is a thing
 * somebody is waiting on — so loading it whole is cheaper than paging it.
 */
async function pendingRelationsOf(viewerId: string): Promise<Map<string, RelationWire>> {
  const [outgoing, incoming] = await Promise.all([
    friendRepository.listOutgoing(viewerId, PAGE_LIMITS.maxLimit, 0),
    friendRepository.listIncoming(viewerId, PAGE_LIMITS.maxLimit, 0),
  ]);

  const relations = new Map<string, RelationWire>();
  for (const request of outgoing) relations.set(String(request.receiverId), RELATION.requestSent);
  for (const request of incoming) {
    relations.set(String(request.senderId), RELATION.requestReceived);
  }

  return relations;
}

/** Keeps an index inside the range the client can draw. */
function clamp(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0;
  const index = Math.floor(value);
  return index < 0 ? 0 : index >= count ? count - 1 : index;
}

export const userService = new UserService();
