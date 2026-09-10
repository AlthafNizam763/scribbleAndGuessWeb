/**
 * Authentication types (brief sections 6 and 7).
 */

/** Which credential a user signed in with. */
export type AuthProvider = 'guest' | 'google' | 'apple' | 'email';

/**
 * The JWT payload.
 *
 * Deliberately minimal: an id, a provider and the standard claims. Everything
 * else — the username, the avatar, the score — is read from the database at
 * use time, because a token lives for 30 days and anything baked into it would
 * be a 30-day-stale copy. The username in particular is editable, so a token
 * carrying it would let a renamed player keep showing their old name.
 */
export interface JwtPayload {
  /** The user's Mongo `_id` as a hex string. */
  sub: string;
  provider: AuthProvider;
  /** Issued-at, seconds since epoch. Added by `jsonwebtoken`. */
  iat?: number;
  /** Expiry, seconds since epoch. Added by `jsonwebtoken`. */
  exp?: number;
}

/** The authenticated caller, attached to a request or a socket. */
export interface AuthenticatedUser {
  id: string;
  username: string;
  avatarId: number;
  avatarColorIndex: number;
  provider: AuthProvider;
}

/**
 * The `POST /api/auth/guest` response body.
 *
 * `avatarId` is an integer index into the 18 procedural avatars, not the
 * `"avatar_01"` string the brief's example shows. The app draws avatars with a
 * `CustomPainter` keyed by `(avatarId, avatarColorIndex)` — there is no asset
 * named `avatar_01` — so a string here would have to be parsed back into that
 * pair by every caller. The pair is carried through as-is instead.
 */
export interface AuthResponse {
  token: string;
  user: {
    id: string;
    username: string;
    avatarId: number;
    avatarColorIndex: number;
  };
}
