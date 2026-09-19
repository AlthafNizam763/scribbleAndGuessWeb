import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';

import { env } from '@/config/env';
import { INPUT_LIMITS } from '@/constants/game.constants';
import { User } from '@/models/User';
import { userRepository } from '@/repositories/user.repository';
import type { AuthProvider, AuthenticatedUser, JwtPayload } from '@/types/auth.types';
import { foldAvatarId } from '@/utils/avatar';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Authentication (brief sections 6 and 7).
 *
 * ## Guests are real accounts
 *
 * `POST /api/auth/guest` creates a `users` row and returns a JWT for it. There
 * is no separate "anonymous" code path: a guest is a user whose `authProvider`
 * is `guest` and who has no credentials. Everything downstream — rooms, scores,
 * reports, the leaderboard — keys off that id and neither knows nor cares how
 * the session was established.
 *
 * That is what makes section 6's "add Google/Apple/email later without a
 * rewrite" true: linking a provider sets `email` and `passwordHash` on the row
 * that already exists, and every game record the player accumulated as a guest
 * follows them. `register` and `login` below are that path, now exposed at
 * `POST /api/auth/register` and `POST /api/auth/login`. A guest who registers
 * while signed in is upgraded in place rather than duplicated.
 *
 * ## Why the token carries so little
 *
 * Just a subject and a provider. A 30-day token that embedded the username
 * would show a stale name for a month after a rename, and one that embedded
 * scores would be a signed lie the moment the next round ended. Anything
 * mutable is read from the database at the point of use.
 */

const BCRYPT_ROUNDS = 12;

export class AuthService {
  /** Signs a token for a user id. */
  issueToken(userId: string, provider: AuthProvider): string {
    const payload: JwtPayload = { sub: userId, provider };
    const options: SignOptions = { expiresIn: env.jwtExpiresIn as SignOptions['expiresIn'] };
    return jwt.sign(payload, env.jwtSecret, options);
  }

  /**
   * Verifies a token and returns its payload, or throws `AUTH_ERROR`.
   *
   * Every failure mode — expired, malformed, wrong signature — is reported as
   * the same generic error. Telling a caller *which* is what turns a token
   * into an oracle for probing the signing key.
   */
  verifyToken(token: string): JwtPayload {
    try {
      const decoded = jwt.verify(token, env.jwtSecret);
      if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
        throw errors.auth('That session token is not valid.');
      }
      return decoded as JwtPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw errors.auth('That session has expired. Sign in again.');
      }
      // Not logged with the token attached: a valid-but-rejected token in a log
      // file is a credential sitting in a log file.
      throw errors.auth('That session token is not valid.');
    }
  }

  /**
   * Resolves a token to the live user, or throws.
   *
   * The database lookup is the point: a token for a deleted account must stop
   * working, and the username it carries must be the current one. Both the
   * REST middleware and the socket handshake go through here, so there is one
   * definition of "who is this".
   */
  async authenticate(token: string): Promise<AuthenticatedUser> {
    const payload = this.verifyToken(token);
    const user = await userRepository.findById(payload.sub);

    if (!user) throw errors.auth('That account no longer exists.');

    // A deleted account keeps its row as a tombstone so other people's match
    // history still renders — see `accountDeletion.service.ts` — so "the row
    // exists" is no longer the same question as "this account may sign in".
    //
    // Checked here rather than at each entry point because this method *is*
    // the entry point: the REST middleware and the socket handshake both
    // resolve identity through it, so one refusal covers every authenticated
    // path, including the ones added after this line was written. The message
    // matches the missing-account one above, so a token that outlived its
    // account is not a way to learn whether that account was deleted.
    if (user.deletedAt) throw errors.auth('That account no longer exists.');

    return {
      id: String(user._id),
      username: user.username,
      avatarId: user.avatarId,
      avatarColorIndex: user.avatarColorIndex,
      provider: (user.authProvider ?? 'guest') as AuthProvider,
    };
  }

  /** Creates a guest account and its first token. */
  async createGuest(input: {
    username: string;
    avatarId: number;
    avatarColorIndex: number;
  }): Promise<{ token: string; user: AuthenticatedUser }> {
    const username = sanitizeUsername(input.username);

    const created = await userRepository.create({
      username,
      avatarId: foldAvatarId(input.avatarId),
      avatarColorIndex: clampIndex(input.avatarColorIndex, INPUT_LIMITS.avatarColorCount),
      provider: 'guest',
    });

    const id = String(created._id);
    logger.info('guest created', { userId: id });

    return {
      token: this.issueToken(id, 'guest'),
      user: {
        id,
        username: created.username,
        avatarId: created.avatarId,
        avatarColorIndex: created.avatarColorIndex,
        provider: 'guest',
      },
    };
  }

  /**
   * Attaches email credentials to an existing account.
   *
   * The upgrade path from section 6. Not routed yet — it is here so that when
   * a route is added, guest history carries over instead of a second account
   * being created alongside the first.
   */
  async attachEmailCredentials(input: {
    userId: string;
    email: string;
    password: string;
  }): Promise<void> {
    const existing = await userRepository.findByEmail(input.email);
    if (existing && String(existing._id) !== input.userId) {
      throw errors.validation('That email is already registered.');
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    await User.updateOne(
      { _id: input.userId },
      { $set: { email: input.email.trim().toLowerCase(), passwordHash, authProvider: 'email' } },
    ).exec();
  }

  /**
   * Creates an email account, or upgrades the caller's guest account into one.
   *
   * The two cases are one method because they must not be allowed to diverge.
   * If `existingUserId` names a guest the caller is already signed in as, the
   * credentials are attached to *that* row and every game, score, friendship
   * and achievement they accumulated as a guest follows them. With no such
   * caller a fresh row is created first and then upgraded through the same
   * path, so a new registration and an upgrade end on identical state.
   *
   * A caller who already has an email account is refused rather than
   * re-credentialed: that request is either a mistake or an attempt to move
   * somebody else's address onto the account in hand.
   */
  async register(input: {
    existingUserId?: string | null;
    existingProvider?: AuthProvider | null;
    username?: string;
    avatarId?: number;
    avatarColorIndex?: number;
    email: string;
    password: string;
  }): Promise<{ token: string; user: AuthenticatedUser; upgraded: boolean }> {
    const email = input.email.trim().toLowerCase();

    const taken = await userRepository.findByEmail(email);
    if (taken && String(taken._id) !== input.existingUserId) {
      throw errors.validation('That email is already registered.');
    }

    const upgrading = Boolean(input.existingUserId) && input.existingProvider === 'guest';

    let userId: string;
    if (upgrading) {
      userId = String(input.existingUserId);
    } else {
      if (input.existingUserId) {
        throw errors.validation('This account already has a sign-in. Sign out first.');
      }
      if (!input.username) {
        throw errors.validation('Choose a display name.');
      }
      const created = await userRepository.create({
        username: sanitizeUsername(input.username),
        avatarId: foldAvatarId(input.avatarId ?? 0),
        avatarColorIndex: clampIndex(input.avatarColorIndex ?? 0, INPUT_LIMITS.avatarColorCount),
        provider: 'guest',
      });
      userId = String(created._id);
    }

    await this.attachEmailCredentials({ userId, email, password: input.password });

    // Re-read rather than trusting the values above: an upgrade keeps whatever
    // name and avatar the guest row already had, which this method never saw.
    const user = await userRepository.findById(userId);
    if (!user) throw errors.internal('Could not create that account.');

    logger.info(upgrading ? 'guest upgraded to email' : 'email account created', { userId });

    return {
      token: this.issueToken(userId, 'email'),
      user: {
        id: userId,
        username: user.username,
        avatarId: user.avatarId,
        avatarColorIndex: user.avatarColorIndex,
        provider: 'email',
      },
      upgraded: upgrading,
    };
  }

  /** Verifies an email/password pair. */
  async login(email: string, password: string): Promise<{ token: string; user: AuthenticatedUser }> {
    const user = await User.findOne({ email: email.trim().toLowerCase() })
      .select('+passwordHash')
      .lean()
      .exec();

    // The same error whether the account is missing or the password is wrong,
    // so this endpoint cannot be used to enumerate registered addresses. A
    // deleted account takes the same path for the same reason — and in any
    // case deletion unsets both `email` and `passwordHash`, so the lookup
    // above will not have found it.
    const genericFailure = errors.auth('That email or password is not right.');
    if (!user?.passwordHash || user.deletedAt) throw genericFailure;

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) throw genericFailure;

    const id = String(user._id);
    return {
      token: this.issueToken(id, 'email'),
      user: {
        id,
        username: user.username,
        avatarId: user.avatarId,
        avatarColorIndex: user.avatarColorIndex,
        provider: 'email',
      },
    };
  }
}

/**
 * Trims, collapses whitespace and strips control characters.
 *
 * Names are rendered next to other players' names in chat and on the
 * scoreboard, so a name with a newline or a zero-width run in it could push
 * the layout around or impersonate somebody else's row. Length is measured in
 * code points, so an emoji counts as one character rather than two.
 */
export function sanitizeUsername(raw: string): string {
  const collapsed = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  const points = [...collapsed];
  if (points.length < INPUT_LIMITS.minNameLength) {
    throw errors.validation(
      `A name needs at least ${INPUT_LIMITS.minNameLength} characters.`,
    );
  }

  return points.slice(0, INPUT_LIMITS.maxNameLength).join('');
}

/** Keeps an avatar index inside the range the client can actually draw. */
function clampIndex(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0;
  const index = Math.floor(value);
  return index < 0 ? 0 : index >= count ? count - 1 : index;
}

export const authService = new AuthService();
