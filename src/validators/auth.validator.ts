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
  avatarId: z.coerce.number().int().min(0).max(INPUT_LIMITS.avatarCount - 1).optional(),
  avatarColorIndex: z.coerce
    .number()
    .int()
    .min(0)
    .max(INPUT_LIMITS.avatarColorCount - 1)
    .optional(),
});
