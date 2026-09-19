import { z } from 'zod';

import { INPUT_LIMITS } from '@/constants/game.constants';
import {
  PROFILE_FRAMES,
  PROFILE_LIMITS,
  PROFILE_THEMES,
} from '@/constants/social.constants';

/**
 * Auth validation (brief sections 5, 7 and 8).
 *
 * The username rule is the interesting one. It allows letters, numbers,
 * spaces, dots, hyphens and underscores from any script — the app ships
 * Malayalam, Hindi, Japanese and Russian word banks, so an English-only name
 * rule would be wrong — and refuses everything else. What it excludes is what
 * makes names dangerous next to each other in a chat list: control characters,
 * zero-width joiners used to fake another player's name, and emoji-only names
 * that render as a blank row.
 */

const usernameSchema = z
  .string()
  .trim()
  .min(INPUT_LIMITS.minNameLength, `A name needs at least ${INPUT_LIMITS.minNameLength} characters.`)
  .max(INPUT_LIMITS.maxNameLength, `A name can be at most ${INPUT_LIMITS.maxNameLength} characters.`)
  .refine((name) => /^[\p{L}\p{N} ._-]+$/u.test(name), {
    message: 'Names can use letters, numbers, spaces, dots, hyphens and underscores.',
  });

const avatarIdSchema = z.coerce.number().int().min(0).max(INPUT_LIMITS.avatarCount - 1).catch(0);

const avatarColorSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(INPUT_LIMITS.avatarColorCount - 1)
  .catch(0);

/** `POST /api/auth/guest`. */
export const guestLoginSchema = z.object({
  username: usernameSchema,
  avatarId: avatarIdSchema.default(0),
  avatarColorIndex: avatarColorSchema.default(0),
});

/**
 * An address, normalised to the form the unique index is built on.
 *
 * Lowercased here rather than at the point of use, so that the value the
 * schema hands downstream is already the value stored — otherwise a
 * registration for `Player@Example.com` and a sign-in for `player@example.com`
 * would disagree about whether they are the same account.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .email('That does not look like an email address.');

/**
 * A password, bounded at both ends.
 *
 * The floor is eight characters. The ceiling is 72 *bytes*, and it is a
 * correctness bound rather than a policy one: bcrypt hashes only the first 72
 * bytes of its input and silently discards the rest, so a longer password
 * would authenticate against its own truncation — two different passwords
 * sharing a 72-byte prefix would open the same account. Measured in bytes,
 * not characters, because the limit is bcrypt's and a multi-byte character
 * spends more than one of them.
 */
const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .refine((value) => new TextEncoder().encode(value).length <= 72, {
    message: 'That password is too long.',
  });

/**
 * `POST /api/auth/register`.
 *
 * The username and avatar are optional because this endpoint serves two
 * callers. A brand-new player sends all four fields. A guest upgrading an
 * account they have already been playing on sends only the credentials, and
 * keeps the name and face their existing row carries.
 */
export const registerSchema = z.object({
  username: usernameSchema.optional(),
  avatarId: avatarIdSchema.optional(),
  avatarColorIndex: avatarColorSchema.optional(),
  email: emailSchema,
  password: passwordSchema,
});

/**
 * `POST /api/auth/login`.
 *
 * The password is only bounded, never pattern-checked. Rejecting a stored
 * password for failing today's rules would lock out an account that was valid
 * when it was made; whether it matches is the hash's business.
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(512),
});

/**
 * `PATCH /api/users/me`.
 *
 * Only these three keys exist. A body carrying `score` or `gamesWon` does not
 * fail — the extra keys are simply not in the schema, so they are stripped
 * before anything downstream sees them (brief section 8).
 */
export const updateProfileSchema = z
  .object({
    username: usernameSchema.optional(),
    avatarId: avatarIdSchema.optional(),
    avatarColorIndex: avatarColorSchema.optional(),

    /**
     * A short self-description.
     *
     * Masked rather than refused if it trips the profanity filter — see
     * `userRepository.updateProfile`. An empty string clears it.
     */
    bio: z.string().trim().max(PROFILE_LIMITS.maxBioLength).optional(),

    /**
     * Cosmetics, as keys from closed sets.
     *
     * An unrecognised key is coerced to the default rather than refused: a
     * client offering a frame this server has retired should still be able to
     * save the rest of its profile.
     */
    profileFrame: z.enum(PROFILE_FRAMES).catch('none').optional(),
    profileTheme: z.enum(PROFILE_THEMES).catch('paper').optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send a username or an avatar to change.',
  });

/** The profile the client sends on the socket handshake. */
export const playerProfileSchema = z.object({
  id: z.string().trim().default(''),
  name: usernameSchema.catch('Player'),
  avatarId: avatarIdSchema.default(0),
  avatarColorIndex: avatarColorSchema.default(0),
});

/**
 * The display profile a client attaches to `c:hello`, `c:room:create` and
 * `c:room:join`, used to mirror the device's chosen name and avatar onto the
 * user row (see `socket/profile.sync.ts`).
 *
 * Two differences from [playerProfileSchema], and both matter. Every field is
 * optional, because an older client may send only some of them. And nothing
 * falls back to a placeholder: the schemas above turn an unusable name into
 * `'Player'` and an unusable avatar into `0`, which is right when the value is
 * being *read*, but catastrophic when it is being *written* — a client with a
 * garbled payload would silently rename the player to `Player` and reset their
 * face. Here an unusable value simply fails, and the caller leaves the stored
 * one alone.
 */
export const profileSyncSchema = z.object({
  name: usernameSchema.optional(),
  // The *legacy* bound: an app built before the cats holds ids up to 17, and
  // rejecting one here would fail the whole sync — including the username,
  // which is the thing this schema exists to keep current. The service folds
  // it onto a cat on write.
  avatarId: z.coerce.number().int().min(0).max(INPUT_LIMITS.legacyAvatarCount - 1).optional(),
  avatarColorIndex: z.coerce
    .number()
    .int()
    .min(0)
    .max(INPUT_LIMITS.avatarColorCount - 1)
    .optional(),
});
