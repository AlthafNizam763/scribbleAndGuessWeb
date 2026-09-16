import type {
  FriendRequestStatus,
  LeaderboardScope,
  RelationWire,
} from '@/constants/social.constants';

/**
 * The shapes the friends, blocks and leaderboard endpoints put on the wire.
 *
 * Every one of these is what a *client* is allowed to see, which is why they
 * are written down separately from the documents they are built from. A
 * `UserDocument` carries an email and a password hash; a `PublicProfileDto`
 * cannot, because it has nowhere to put them.
 */

/** The minimum needed to draw a person: a name and an avatar. */
export interface UserSummaryDto {
  id: string;
  username: string;
  avatarId: number;
  avatarColorIndex: number;
}

/** A user's public career record, as shown on a profile and a leaderboard. */
export interface UserStatsDto {
  totalScore: number;
  gamesPlayed: number;
  gamesWon: number;
  /** Rounded to one decimal place, 0 when nothing has been played. */
  winRate: number;
  bestRoundScore: number;
  /** Lifetime XP. Server-computed; a client can only read it. */
  xp: number;
  /** The level that XP buys, and its tier name. */
  level: number;
  levelTitle: string;
}

/** A town, as the locality board shows it. Never an address. */
export interface LocalityDto {
  city: string | null;
  region: string | null;
  country: string | null;
  /** A single display line, e.g. `Kochi, IN`. Null when nothing is set. */
  label: string | null;
}

/** One row of any leaderboard. */
export interface LeaderboardRowDto extends UserSummaryDto, UserStatsDto {
  /** 1-based, and absolute within the scope rather than within the page. */
  rank: number;
  /**
   * Places gained since the last recorded ranking, or null when there is no
   * history to compare against.
   *
   * Positive means moved up the board. This is only ever non-null once
   * ranking history exists — see `RankingHistory` in `leaderboard.service.ts`.
   */
  rankChange: number | null;
  /** Whether this row is the caller. Lets the client highlight without a compare. */
  isSelf: boolean;
  /** Only populated on the locality board, so a row can show where it is from. */
  locality: LocalityDto | null;
}

/** A leaderboard page, in the envelope the brief specifies. */
export interface LeaderboardPageDto {
  scope: LeaderboardScope;
  items: LeaderboardRowDto[];
  /** The caller's absolute rank in this scope, or null when unranked. */
  currentUserRank: number | null;
  /** The caller's own row, so it can be pinned outside the page. */
  currentUserEntry: LeaderboardRowDto | null;
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  /** Present on the locality board: whose town this is. */
  locality?: LocalityDto | null;
}

/** A friend, with enough to render a row and open a profile. */
export interface FriendDto extends UserSummaryDto, UserStatsDto {
  /** When the friendship was accepted, as epoch milliseconds. */
  friendsSinceMs: number;
  lastSeenAtMs: number;
}

/** A pending request, from whichever side is looking at it. */
export interface FriendRequestDto {
  id: string;
  status: FriendRequestStatus;
  createdAtMs: number;
  updatedAtMs: number;
  /**
   * The *other* party, never the caller.
   *
   * An incoming request's `user` is the sender and an outgoing one's is the
   * receiver, because that is the only one worth drawing: a list of requests
   * showing the reader's own avatar over and over tells them nothing.
   */
  user: UserSummaryDto;
}

/** A blocked user, as their blocker sees them. */
export interface BlockDto extends UserSummaryDto {
  blockedAtMs: number;
}

/** A full profile, plus how the caller stands relative to it. */
export interface PublicProfileDto extends UserSummaryDto {
  /** A short self-description, masked by the profanity filter on save. */
  bio: string;
  /** Cosmetic keys. An unknown key renders as the default. */
  profileFrame: string;
  profileTheme: string;
  /** The category this player plays most, or null before they have one. */
  favoriteCategory: string | null;
  stats: UserStatsDto;
  locality: LocalityDto | null;
  /** The world rank, or null when this user has never finished a game. */
  rank: number | null;
  lastSeenAtMs: number;
  createdAtMs: number;
  /**
   * What the caller may do next.
   *
   * The single value the profile screen's button is driven from. Computed
   * server-side from the actual rows, never inferred by the client.
   */
  relation: RelationWire;
  /** The request id to act on, when `relation` is a pending one. */
  pendingRequestId: string | null;
}
