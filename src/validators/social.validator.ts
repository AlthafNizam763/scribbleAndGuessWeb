import { z } from 'zod';

import {
  LEADERBOARD_SCOPE,
  LOCALITY_LIMITS,
  PAGE_LIMITS,
  SEARCH_LIMITS,
} from '@/constants/social.constants';

/**
 * Validation for the friends, blocks and leaderboard endpoints.
 *
 * ## The same "coerce, do not reject" rule as the room validators
 *
 * A `limit` of 5000 is a client with an optimistic default, not an attack, so
 * it is clamped to the maximum and the request succeeds. What is *not*
 * coerced is anything that changes who the request is about: an id of the
 * wrong shape is refused rather than repaired, because there is no sensible
 * repair and guessing would aim the action at somebody else.
 *
 * ## What is deliberately absent
 *
 * No schema here accepts a `senderId`, a `userId`, a `totalScore`, a `rank` or
 * a relation. Every one of those comes from the verified token or from the
 * database. The send-request body names a receiver and nothing else, so there
 * is no field a caller could use to send a request *as* somebody else — the
 * same argument as `user.service.ts`: a call that cannot express the write
 * cannot make it.
 */

/**
 * A Mongo id, as it arrives in a path segment or a body.
 *
 * 24 hex characters, checked here so a malformed id becomes a 422 with a
 * readable message instead of reaching a query. `isObjectId` in the repository
 * layer is the second lock on the same door, for ids that arrive by other
 * routes.
 */
export const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'That is not a valid player id.');

/** `?page=&limit=`, clamped rather than refused. */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().catch(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .catch(PAGE_LIMITS.defaultLimit)
    .default(PAGE_LIMITS.defaultLimit)
    .transform((value) => Math.min(Math.max(value, 1), PAGE_LIMITS.maxLimit)),
});

/** `GET /api/leaderboard/me/rank?scope=world`. */
export const rankQuerySchema = z.object({
  scope: z
    .enum([LEADERBOARD_SCOPE.world, LEADERBOARD_SCOPE.friends, LEADERBOARD_SCOPE.locality])
    .catch(LEADERBOARD_SCOPE.world)
    .default(LEADERBOARD_SCOPE.world),
});

/**
 * `GET /api/users/search?q=`.
 *
 * The term is bounded at both ends. Too short and the anchored prefix matches
 * most of the collection for no useful result; too long and it is not a name.
 * Both are enforced here so the repository never builds a regex it should not.
 */
export const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(SEARCH_LIMITS.minTermLength, `Type at least ${SEARCH_LIMITS.minTermLength} characters.`)
    .max(SEARCH_LIMITS.maxTermLength),
  limit: z.coerce
    .number()
    .int()
    .catch(SEARCH_LIMITS.maxResults)
    .default(SEARCH_LIMITS.maxResults)
    .transform((value) => Math.min(Math.max(value, 1), SEARCH_LIMITS.maxResults)),
});

/**
 * `POST /api/friends/requests`.
 *
 * Accepts `receiverId` or `userId` for the same field, because both spellings
 * are natural and a client that guesses wrong would otherwise get a validation
 * error it cannot diagnose. There is no `senderId`: the sender is the token.
 */
export const sendFriendRequestSchema = z
  .object({
    receiverId: objectIdSchema.optional(),
    userId: objectIdSchema.optional(),
  })
  .refine((body) => body.receiverId !== undefined || body.userId !== undefined, {
    message: 'A player id is required.',
  })
  .transform((body) => ({ receiverId: (body.receiverId ?? body.userId) as string }));

/**
 * The locality fields on `PATCH /api/users/me/locality`.
 *
 * Only a town, a region and a country code — the schema has no field for a
 * street, a postcode or a coordinate, which is the same structural refusal the
 * profile patch makes for scores. An empty string is normalised to null so
 * clearing a field and never setting it are the same state.
 */
export const localitySchema = z.object({
  city: z
    .string()
    .trim()
    .max(LOCALITY_LIMITS.maxCityLength)
    .nullish()
    .transform(emptyToNull),
  region: z
    .string()
    .trim()
    .max(LOCALITY_LIMITS.maxRegionLength)
    .nullish()
    .transform(emptyToNull),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use a two-letter country code, like IN or DE.')
    .nullish()
    .transform(emptyToNull),
});

/** `POST /api/rooms/quick-play`. Takes no parameters, by design. */
export const quickPlaySchema = z.object({}).passthrough();

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
