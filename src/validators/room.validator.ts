import { z } from 'zod';

import { INPUT_LIMITS, ROOM_CODE, ROOM_LIMITS } from '@/constants/game.constants';
import { LANGUAGES, WORD_CATEGORIES, WORD_MODES } from '@/constants/room.constants';

/**
 * Room validation (brief sections 12, 13 and 50).
 *
 * ## Coerce, do not reject
 *
 * Numeric settings are clamped into range rather than refused. A client that
 * sends `rounds: 999` is not attacking anything — it is out of date, or it has
 * a slider whose bounds drifted from the server's. Clamping gives that player
 * a working game with ten rounds; rejecting gives them an error dialog they
 * cannot act on. Anything that cannot be sensibly coerced — a room code of the
 * wrong shape, a category that does not exist — is still refused.
 *
 * The one thing never coerced is a permission. Those are not in this file at
 * all; they are checked in the services against server state.
 */

/** Clamps an integer into `[min, max]`, defaulting anything unusable. */
const clampedInt = (min: number, max: number, fallback: number) =>
  z
    .unknown()
    .transform((value) => {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      const rounded = Math.round(parsed);
      return rounded < min ? min : rounded > max ? max : rounded;
    })
    .pipe(z.number().int().min(min).max(max));

/** A room code: five characters from the unambiguous alphabet. */
export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((code) => code.replace(/[\s-]/g, ''))
  .refine((code) => code.length === ROOM_CODE.length, {
    message: `A room code is ${ROOM_CODE.length} characters.`,
  })
  .refine((code) => [...code].every((char) => ROOM_CODE.alphabet.includes(char)), {
    message: 'That room code contains characters we do not use.',
  });

/**
 * Room settings, matching the client's `RoomSettings.toJson`.
 *
 * Every field has a default, so a partial payload from an older client build
 * produces a complete, playable settings object rather than an error.
 */
export const roomSettingsSchema = z.object({
  maxPlayers: clampedInt(
    ROOM_LIMITS.maxPlayers.min,
    ROOM_LIMITS.maxPlayers.max,
    8,
  ).default(8),

  rounds: clampedInt(ROOM_LIMITS.rounds.min, ROOM_LIMITS.rounds.max, 3).default(3),

  drawTimeSeconds: clampedInt(
    ROOM_LIMITS.drawTimeSeconds.min,
    ROOM_LIMITS.drawTimeSeconds.max,
    80,
  ).default(80),

  wordChoiceCount: clampedInt(
    ROOM_LIMITS.wordChoiceCount.min,
    ROOM_LIMITS.wordChoiceCount.max,
    3,
  ).default(3),

  hintCount: clampedInt(ROOM_LIMITS.hintCount.min, ROOM_LIMITS.hintCount.max, 2).default(2),

  wordSelectSeconds: clampedInt(
    ROOM_LIMITS.wordSelectSeconds.min,
    ROOM_LIMITS.wordSelectSeconds.max,
    15,
  ).default(15),

  wordMode: z.enum(WORD_MODES).catch('normal').default('normal'),
  language: z.enum(LANGUAGES).catch('en').default('en'),

  // Unknown categories are dropped rather than rejected, so a client shipping
  // a category this server has not deployed yet still gets a valid room.
  categories: z
    .array(z.string())
    .default([])
    .transform((values) =>
      values.filter((value): value is (typeof WORD_CATEGORIES)[number] =>
        (WORD_CATEGORIES as readonly string[]).includes(value),
      ),
    ),

  customWords: z
    .array(z.string())
    .default([])
    .transform((words) =>
      words
        .map((word) => word.trim())
        .filter(
          (word) =>
            word.length >= ROOM_LIMITS.customWords.minLength &&
            word.length <= ROOM_LIMITS.customWords.maxLength,
        )
        // A custom list is a game's whole word pool, so it is capped: an
        // unbounded array here would be an unbounded document in Mongo.
        .slice(0, 200),
    ),

  allowVoteKick: z.boolean().catch(true).default(true),
  isPrivate: z.boolean().catch(false).default(false),
});

export type RoomSettingsInput = z.infer<typeof roomSettingsSchema>;

/** `POST /api/rooms`. The body is the settings, all of it optional. */
export const createRoomSchema = z.object({
  settings: roomSettingsSchema.optional(),
  // The brief's example puts the settings at the top level, so both shapes are
  // accepted: `{maxPlayers: 8}` and `{settings: {maxPlayers: 8}}`.
  maxPlayers: z.unknown().optional(),
  rounds: z.unknown().optional(),
  drawTimeSeconds: z.unknown().optional(),
  wordsToChoose: z.unknown().optional(),
  wordChoiceCount: z.unknown().optional(),
  hintsEnabled: z.unknown().optional(),
  hintCount: z.unknown().optional(),
  wordMode: z.unknown().optional(),
  language: z.unknown().optional(),
  categories: z.unknown().optional(),
  customWords: z.unknown().optional(),
  allowVoteKick: z.unknown().optional(),
  isPrivate: z.unknown().optional(),
});

/** `POST /api/rooms/join`. */
export const joinRoomSchema = z.object({
  roomCode: roomCodeSchema.optional(),
  code: roomCodeSchema.optional(),
}).refine((body) => body.roomCode !== undefined || body.code !== undefined, {
  message: 'A room code is required.',
});

/** `PATCH /api/rooms/:roomId/settings`. */
export const updateSettingsSchema = z.object({
  settings: roomSettingsSchema,
});

/** `POST /api/rooms/:roomId/ready`. */
export const readySchema = z.object({
  ready: z.boolean().default(true),
});

/** Any action naming another player. */
export const playerTargetSchema = z.object({
  playerId: z.string().trim().min(1, 'A player id is required.'),
});

/** `moderation:mute`. */
export const muteSchema = playerTargetSchema.extend({
  muted: z.boolean().default(true),
});

/** `moderation:report`. */
export const reportSchema = playerTargetSchema.extend({
  reason: z
    .string()
    .trim()
    .min(1, 'Add a reason for the report.')
    .max(INPUT_LIMITS.maxReportLength),
});

/**
 * Folds the brief's flat body shape into the nested settings object.
 *
 * `hintsEnabled: false` is honoured by zeroing the hint count, which is what
 * the flag means; the server has no separate "hints on" switch because a count
 * of zero already says it.
 */
export function normalizeCreateRoomBody(body: z.infer<typeof createRoomSchema>): unknown {
  if (body.settings !== undefined) return body.settings;

  const flat: Record<string, unknown> = {
    maxPlayers: body.maxPlayers,
    rounds: body.rounds,
    drawTimeSeconds: body.drawTimeSeconds,
    wordChoiceCount: body.wordChoiceCount ?? body.wordsToChoose,
    hintCount: body.hintsEnabled === false ? 0 : body.hintCount,
    wordMode: body.wordMode,
    language: body.language,
    categories: body.categories,
    customWords: body.customWords,
    allowVoteKick: body.allowVoteKick,
    isPrivate: body.isPrivate,
  };

  for (const key of Object.keys(flat)) {
    if (flat[key] === undefined) delete flat[key];
  }

  return flat;
}
