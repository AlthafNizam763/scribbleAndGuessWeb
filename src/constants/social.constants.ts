/**
 * The friends, blocks and leaderboard vocabulary.
 *
 * Kept beside `room.constants.ts` rather than inside the models so the socket
 * layer, the validators and the Flutter client all read the same list. As with
 * the room enums, these strings travel on the wire: a value changed here is a
 * protocol change, not a rename.
 */

/** The lifecycle of a friend request. */
export const FRIEND_REQUEST_STATUS = {
  /** Sent, and waiting on the receiver. The only status that blocks a resend. */
  pending: 'pending',
  /** The receiver said yes. A `Friendship` row exists for the pair. */
  accepted: 'accepted',
  /** The receiver said no. */
  rejected: 'rejected',
  /** The sender took it back, or a block resolved it. */
  cancelled: 'cancelled',
} as const;

export type FriendRequestStatus =
  (typeof FRIEND_REQUEST_STATUS)[keyof typeof FRIEND_REQUEST_STATUS];

/**
 * How the caller stands relative to another user.
 *
 * This is what drives the profile screen's button, and it is computed on the
 * server for exactly that reason: a client that decided for itself whether it
 * was friends with somebody would be deciding whether it may message them.
 * The client renders the state it is given and nothing else.
 */
export const RELATION = {
  /** The caller looking at their own profile. */
  self: 'self',
  /** No request, no friendship, no block in either direction. */
  none: 'none',
  /** The caller has a pending request out to this user. */
  requestSent: 'request_sent',
  /** This user has a pending request in to the caller. */
  requestReceived: 'request_received',
  /** Accepted, both ways. */
  friends: 'friends',
  /** The caller blocked this user. Only the caller ever sees this. */
  blocked: 'blocked',
  /**
   * This user blocked the caller.
   *
   * Never sent to the blocked party — the serializer collapses it to `none`,
   * so being blocked is indistinguishable from never having interacted. It
   * exists as a value because the *server* has to branch on it.
   */
  blockedBy: 'blocked_by',
} as const;

export type RelationWire = (typeof RELATION)[keyof typeof RELATION];

/** Which population a leaderboard page is drawn from. */
export const LEADERBOARD_SCOPE = {
  world: 'world',
  friends: 'friends',
  locality: 'locality',
} as const;

export type LeaderboardScope = (typeof LEADERBOARD_SCOPE)[keyof typeof LEADERBOARD_SCOPE];

/** Paging bounds shared by every leaderboard and list endpoint. */
export const PAGE_LIMITS = {
  defaultLimit: 25,
  maxLimit: 100,
  /**
   * How deep `page` may go.
   *
   * A skip-based page is `O(skip)` in Mongo, so an unbounded `page` is a way
   * to make the server do arbitrary work for one request. Anything past this
   * is refused rather than clamped, because silently returning page 200 when
   * page 20000 was asked for would look like data loss.
   */
  maxPage: 400,
} as const;

/** Bounds on user search. */
export const SEARCH_LIMITS = {
  minTermLength: 2,
  maxTermLength: 24,
  maxResults: 25,
} as const;

/** Bounds on the locality fields a player may set on their own profile. */
export const LOCALITY_LIMITS = {
  maxCityLength: 64,
  maxRegionLength: 64,
  /** ISO 3166-1 alpha-2, so exactly two letters. */
  countryLength: 2,
} as const;
