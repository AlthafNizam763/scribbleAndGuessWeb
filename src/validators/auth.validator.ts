import { z } from 'zod';

import { INPUT_LIMITS } from '@/constants/game.constants';

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
