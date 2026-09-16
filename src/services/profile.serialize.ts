import { levelForXp, titleForLevel } from '@/constants/progression.constants';
import type {
  LeaderboardRowDto,
  LocalityDto,
  UserStatsDto,
  UserSummaryDto,
} from '@/types/social.types';

/**
 * Turning a user row into the things a client is allowed to see.
 *
 * ## Why this is one module rather than a method on each service
 *
 * The leaderboard, the friends list, user search and the profile screen all
 * render the same person, and they must render them identically: the same
 * win rate, the same locality label, the same fields present. Three services
 * each mapping a row their own way is how a board ends up showing a win rate
 * the profile disagrees with.
 *
 * It is also the layer that decides what *cannot* be sent. A `UserDocument`
 * carries an email, an auth provider and a password hash; none of the shapes
 * below has a field to put them in, so no caller can leak one by forgetting
 * to strip it.
 */

/** The subset of a user row every serializer here reads. */
export interface RankableUser {
  _id: unknown;
  username: string;
  avatarId: number;
  avatarColorIndex: number;
  totalScore: number;
  gamesPlayed: number;
  gamesWon: number;
  bestRoundScore: number;
  bio?: string | null;
  profileFrame?: string | null;
  profileTheme?: string | null;
  favoriteCategory?: string | null;
  /**
   * Optional because the leaderboard projections do not always select them,
   * and because rows written before the progression feature landed have
   * neither. Both default to a level-1 account, which is what an account with
   * no XP is.
   */
  xp?: number | null;
  level?: number | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  localityKey?: string | null;
  lastSeenAt?: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export function toUserSummary(user: RankableUser): UserSummaryDto {
  return {
    id: String(user._id),
    username: user.username,
    avatarId: user.avatarId,
    avatarColorIndex: user.avatarColorIndex,
  };
}

/**
 * Lifetime statistics, with the win rate computed rather than stored.
 *
 * Deriving it is the whole point: a stored win rate is a third number that can
 * disagree with the two it comes from, and the only way to keep it honest is
 * to recompute it on every write anyway. Zero games is reported as a zero rate
 * rather than as null, because "0%" and "no games yet" are already
 * distinguishable from `gamesPlayed`.
 */
export function toUserStats(user: RankableUser): UserStatsDto {
  const played = Math.max(0, user.gamesPlayed);
  const won = Math.max(0, user.gamesWon);

  // Derived from `xp` rather than read from `level`, for the same reason the
  // win rate is derived: a stored level that disagrees with the XP beside it
  // is a third number, and the only way to keep it honest is to recompute it.
  // The stored `level` exists so the *database* can sort by it, not so this
  // can read it.
  const xp = Math.max(0, user.xp ?? 0);
  const level = levelForXp(xp);

  return {
    totalScore: user.totalScore,
    gamesPlayed: played,
    gamesWon: won,
    winRate: played === 0 ? 0 : Math.round((won / played) * 1000) / 10,
    bestRoundScore: user.bestRoundScore,
    xp,
    level,
    levelTitle: titleForLevel(level),
  };
}

/**
 * The town a player plays from, or null when they have not said.
 *
 * `label` is built here rather than on the client so every surface spells a
 * locality the same way, and so the client never has to decide which of the
 * three fields to fall back to.
 */
export function toLocality(user: RankableUser): LocalityDto | null {
  const city = clean(user.city);
  const region = clean(user.region);
  const country = clean(user.country);

  if (!city && !region && !country) return null;

  const label = [city, region ?? undefined, country ?? undefined]
    .filter((part): part is string => Boolean(part))
    .join(', ');

  return { city, region, country, label: label.length > 0 ? label : null };
}

/** One leaderboard row, at an absolute rank within its scope. */
export function toLeaderboardRow(
  user: RankableUser,
  options: {
    rank: number;
    selfId: string | null;
    /** Places gained since the previous ranking, or null with no history. */
    rankChange?: number | null;
    /** Only the locality board carries this; elsewhere it is noise. */
    includeLocality?: boolean;
  },
): LeaderboardRowDto {
  const id = String(user._id);

  return {
    ...toUserSummary(user),
    ...toUserStats(user),
    rank: options.rank,
    rankChange: options.rankChange ?? null,
    isSelf: options.selfId !== null && id === options.selfId,
    locality: options.includeLocality ? toLocality(user) : null,
  };
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
