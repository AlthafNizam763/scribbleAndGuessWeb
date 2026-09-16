import { Types } from 'mongoose';

import { User, type UserDocument } from '@/models/User';
import { maskProfanity } from '@/utils/wordFilter';
import type { AuthProvider } from '@/types/auth.types';

/**
 * Data access for `users`.
 *
 * Repositories here are deliberately thin: they own queries and nothing else.
 * No permission checks, no scoring, no broadcasting — that all lives in the
 * services, so a query can be reused by any caller without dragging rules
 * along with it.
 */

export interface CreateUserInput {
  username: string;
  avatarId: number;
  avatarColorIndex: number;
  provider: AuthProvider;
  email?: string | null;
}

/** Whether a string is a well-formed Mongo id, before it reaches a query. */
export function isObjectId(value: string): boolean {
  return Types.ObjectId.isValid(value) && String(new Types.ObjectId(value)) === value;
}

export const userRepository = {
  async create(input: CreateUserInput): Promise<UserDocument & { _id: Types.ObjectId }> {
    const user = await User.create({
      username: input.username,
      avatarId: input.avatarId,
      avatarColorIndex: input.avatarColorIndex,
      authProvider: input.provider,
      email: input.email ?? null,
      lastSeenAt: new Date(),
    });
    return user as UserDocument & { _id: Types.ObjectId };
  },

  async findById(id: string) {
    if (!isObjectId(id)) return null;
    return User.findById(id).lean().exec();
  },

  async findByEmail(email: string) {
    return User.findOne({ email: email.trim().toLowerCase() }).lean().exec();
  },

  /**
   * Updates the profile fields a player is allowed to change.
   *
   * The `Pick` is the permission: there is no path through this method by
   * which a score, a counter, an XP total or a level could be written, so a
   * client cannot set one however it shapes its request. Everything else on
   * the row is written by the game engine.
   *
   * The bio is masked rather than refused. It is free text on a public
   * profile, so it goes through the same filter chat does — and masking is the
   * kinder failure for a false positive: the profile still saves, with one
   * word starred, instead of an error the player cannot act on.
   */
  async updateProfile(
    id: string,
    patch: Partial<
      Pick<
        UserDocument,
        'username' | 'avatarId' | 'avatarColorIndex' | 'bio' | 'profileFrame' | 'profileTheme'
      >
    >,
  ) {
    if (!isObjectId(id)) return null;

    const safe =
      typeof patch.bio === 'string'
        ? { ...patch, bio: maskProfanity(patch.bio).text }
        : patch;

    return User.findByIdAndUpdate(id, { $set: safe }, { new: true, runValidators: true })
      .lean()
      .exec();
  },

  /**
   * Stamps liveness without loading the document.
   *
   * Called on connect and on reconnect, never on a timer: writing presence
   * every second would be a write per player per second for information
   * nothing reads at that resolution (brief section 37).
   */
  async touch(id: string): Promise<void> {
    if (!isObjectId(id)) return;
    await User.updateOne({ _id: id }, { $set: { lastSeenAt: new Date() } }).exec();
  },

  /**
   * Folds one finished match into a player's lifetime totals.
   *
   * `$inc` rather than read-modify-write: two games finishing at once for the
   * same player would otherwise race and lose one of the increments.
   */
  async recordGameResult(
    id: string,
    input: { scored: number; won: boolean; bestRoundScore: number },
  ): Promise<void> {
    if (!isObjectId(id)) return;
    await User.updateOne(
      { _id: id },
      {
        $inc: {
          gamesPlayed: 1,
          gamesWon: input.won ? 1 : 0,
          totalScore: Math.max(0, input.scored),
        },
        $max: { bestRoundScore: Math.max(0, input.bestRoundScore) },
        $set: { lastSeenAt: new Date() },
      },
    ).exec();
  },

  /**
   * Replaces the locality fields, deriving the grouping key from them.
   *
   * The key is computed here rather than taken from the caller, which is what
   * guarantees it always matches the display fields beside it. Clearing every
   * field clears the key too, which is what drops a player off the locality
   * board rather than stranding them in a town they no longer claim.
   */
  async updateLocality(
    id: string,
    patch: { city: string | null; region: string | null; country: string | null },
  ) {
    if (!isObjectId(id)) return null;

    return User.findByIdAndUpdate(
      id,
      { $set: { ...patch, localityKey: localityKeyOf(patch) } },
      { new: true, runValidators: true },
    )
      .lean()
      .exec();
  },

  // --------------------------------------------------------- leaderboards --

  /**
   * The world leaderboard page, highest lifetime score first.
   *
   * `gamesPlayed > 0` is the eligibility rule: a table whose tail is thousands
   * of guest accounts on zero is not a leaderboard. The sort keys and their
   * order match `{totalScore: -1, gamesWon: -1, _id: 1}` on `User` exactly, so
   * this is an index walk with no in-memory sort.
   */
  async leaderboard(limit: number, skip: number, excludeIds: string[] = []) {
    return User.find(rankedFilter(excludeIds))
      .sort(RANK_SORT)
      .skip(skip)
      .limit(limit)
      .select(LEADERBOARD_FIELDS)
      .lean()
      .exec();
  },

  async countRanked(excludeIds: string[] = []): Promise<number> {
    return User.countDocuments(rankedFilter(excludeIds)).exec();
  },

  /**
   * One page of a leaderboard restricted to an explicit set of users.
   *
   * Serves the friends board. Unlike the world board this does *not* filter on
   * `gamesPlayed`: a friend who has never played still belongs in a list of
   * your friends, on zero, rather than vanishing from it.
   */
  async leaderboardForIds(ids: string[], limit: number, skip: number) {
    if (ids.length === 0) return [];

    return User.find({ _id: { $in: ids.filter(isObjectId).map(toObjectId) } })
      .sort(RANK_SORT)
      .skip(skip)
      .limit(limit)
      .select(LEADERBOARD_FIELDS)
      .lean()
      .exec();
  },

  async countForIds(ids: string[]): Promise<number> {
    const valid = ids.filter(isObjectId);
    if (valid.length === 0) return 0;
    return User.countDocuments({ _id: { $in: valid.map(toObjectId) } }).exec();
  },

  /** One page of the leaderboard for a single town. */
  async leaderboardForLocality(
    localityKey: string,
    limit: number,
    skip: number,
    excludeIds: string[] = [],
  ) {
    return User.find({ localityKey, ...rankedFilter(excludeIds) })
      .sort(RANK_SORT)
      .skip(skip)
      .limit(limit)
      .select(LEADERBOARD_FIELDS)
      .lean()
      .exec();
  },

  async countForLocality(localityKey: string, excludeIds: string[] = []): Promise<number> {
    return User.countDocuments({ localityKey, ...rankedFilter(excludeIds) }).exec();
  },

  /**
   * How many ranked players sit strictly above this one.
   *
   * Rank is derived, never stored: a stored rank would be wrong for every
   * player but one the instant anybody finished a game. Counting instead means
   * the number is always current, and it costs one indexed count rather than a
   * rewrite of the whole collection after every match.
   *
   * The predicate is the sort order written out as a comparison. `totalScore`
   * strictly greater, or equal score with more wins, or both equal and a
   * smaller `_id` — exactly the three cases in which the index would have
   * placed a row ahead of this one. That is what makes "rank 25" here and
   * "25th row on the page" agree, including across ties.
   */
  async rankAbove(
    reference: { totalScore: number; gamesWon: number; id: string },
    scope: { localityKey?: string; ids?: string[]; excludeIds?: string[] } = {},
  ): Promise<number> {
    if (!isObjectId(reference.id)) return 0;

    const base: Record<string, unknown> =
      scope.ids === undefined
        ? { ...rankedFilter(scope.excludeIds ?? []) }
        : { _id: { $in: scope.ids.filter(isObjectId).map(toObjectId) } };

    if (scope.localityKey !== undefined) base.localityKey = scope.localityKey;

    return User.countDocuments({
      ...base,
      $or: [
        { totalScore: { $gt: reference.totalScore } },
        { totalScore: reference.totalScore, gamesWon: { $gt: reference.gamesWon } },
        {
          totalScore: reference.totalScore,
          gamesWon: reference.gamesWon,
          _id: { $lt: toObjectId(reference.id) },
        },
      ],
    }).exec();
  },

  // --------------------------------------------------------------- search --

  /**
   * Finds users whose name starts with [term].
   *
   * Anchored rather than free-floating: `^ann` is a name search, `ann`
   * anywhere in the string is a substring scan that also matches `Susanna`
   * and cannot use the index at all. Case-insensitive because nobody types
   * their friend's capitalisation correctly.
   *
   * [excludeIds] carries the caller plus everyone a block stands between, so
   * a blocked user is simply not in the world as far as search is concerned.
   */
  async searchByUsername(term: string, limit: number, excludeIds: string[] = []) {
    const pattern = new RegExp(`^${escapeRegex(term)}`, 'i');

    const filter: Record<string, unknown> = { username: pattern };
    if (excludeIds.length > 0) {
      filter._id = { $nin: excludeIds.filter(isObjectId).map(toObjectId) };
    }

    return User.find(filter)
      .sort({ totalScore: -1, _id: 1 })
      .limit(limit)
      .select(LEADERBOARD_FIELDS)
      .lean()
      .exec();
  },

  /** Several users at once, for building a list from a set of ids. */
  async findManyByIds(ids: string[]) {
    const valid = ids.filter(isObjectId);
    if (valid.length === 0) return [];

    return User.find({ _id: { $in: valid.map(toObjectId) } })
      .select(LEADERBOARD_FIELDS)
      .lean()
      .exec();
  },

  /** Whether an account still exists, without loading it. */
  async exists(id: string): Promise<boolean> {
    if (!isObjectId(id)) return false;
    return (await User.exists({ _id: id }).exec()) !== null;
  },
};

// ---------------------------------------------------------------------------
// Query fragments
// ---------------------------------------------------------------------------

/**
 * The ranking order, in one place.
 *
 * Score first, wins as the tie-break, `_id` as the final one. That last key is
 * what makes the order *total*: without it two players on the same score and
 * wins could come back in either order, and a board that reshuffles equal rows
 * on refresh reads as broken even though nothing changed. It also has to match
 * the compound index on `User` key-for-key, or the sort stops being free.
 */
const RANK_SORT = { totalScore: -1, gamesWon: -1, _id: 1 } as const;

/** Everything a leaderboard row or a profile card needs, and nothing more. */
const LEADERBOARD_FIELDS =
  'username avatarId avatarColorIndex totalScore gamesPlayed gamesWon bestRoundScore city region country localityKey lastSeenAt createdAt updatedAt';

/** Eligible for the world board, minus anyone the caller cannot see. */
function rankedFilter(excludeIds: string[]): Record<string, unknown> {
  const filter: Record<string, unknown> = { gamesPlayed: { $gt: 0 } };
  const valid = excludeIds.filter(isObjectId);
  if (valid.length > 0) filter._id = { $nin: valid.map(toObjectId) };
  return filter;
}

function toObjectId(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

/**
 * Makes a user-supplied search term safe to embed in a regex.
 *
 * Without this a term of `.*` matches every account and a term like `(((`
 * throws out of the `RegExp` constructor. Escaping is the fix rather than
 * rejecting the characters, because a name may legitimately contain them.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The grouping key for a locality, or null when there is nothing to group by.
 *
 * Lower-cased and punctuation-stripped so `Kochi`, `kochi` and `Kochi ` are
 * one town, and prefixed by country so two same-named towns in different
 * countries are two. Country alone is deliberately *not* enough: a
 * country-wide "locality" board is just a worse world board.
 */
function localityKeyOf(patch: {
  city: string | null;
  region: string | null;
  country: string | null;
}): string | null {
  const city = normalizePlace(patch.city);
  if (!city) return null;

  const country = normalizePlace(patch.country);
  const region = normalizePlace(patch.region);

  return [country, region, city].filter(Boolean).join('|');
}

function normalizePlace(value: string | null): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export { localityKeyOf, normalizePlace };
