import { timingSafeEqual } from 'node:crypto';

import { env } from '@/config/env';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { tournamentBot } from '@/services/tournament/bot.service';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * `POST /api/internal/tournaments/scheduler`
 *
 * One tick of the organiser, driven from outside.
 *
 * ## Why this exists beside the in-process loop
 *
 * Two deployment shapes. A always-on Node process can run the loop itself —
 * that is `TOURNAMENT_SCHEDULER_ENABLED=true`, the default. A platform that
 * sleeps idle services, or one where the operator would rather own the
 * schedule, points a cron at this instead.
 *
 * Both are safe at the same time. Every tick takes the same distributed lock,
 * so a cron firing while the loop is mid-tick is refused the lock and returns
 * `ran: false` — which is the lock working, not a failure, and is why the
 * response says so rather than erroring.
 *
 * ## The secret
 *
 * This endpoint creates tournaments, cancels them, seats AI players and
 * decides matches. It is not something to leave open, so an unset secret
 * refuses every call in production. In development an unset secret allows the
 * call, because driving the loop by hand while building is the normal thing to
 * want and configuring a secret to do it would just mean everybody sets the
 * same one.
 *
 * The comparison is constant-time. A plain `===` on a secret leaks its prefix
 * to anybody willing to time a few thousand requests.
 */
export const POST = withErrorHandling(async (request: Request) => {
  assertAuthorised(request);

  const result = await tournamentBot.tick();

  if (!result.ran) {
    logger.debug('external scheduler tick skipped', { reason: result.skippedReason });
  }

  return ok(result);
});

/**
 * `GET` is the same tick.
 *
 * Some cron services only issue GETs. The action is idempotent under the lock
 * either way, so refusing one over the verb would be pedantry that costs a
 * deployment its scheduler.
 */
export const GET = POST;

/** Refuses anything without the shared secret. */
function assertAuthorised(request: Request): void {
  const expected = env.tournament.schedulerSecret;

  if (expected.length === 0) {
    if (env.isProduction) {
      logger.error('the tournament scheduler endpoint was called with no secret configured');
      throw errors.auth('This endpoint is not configured.');
    }
    return;
  }

  const header =
    request.headers.get('x-scheduler-secret') ??
    bearer(request.headers.get('authorization')) ??
    '';

  if (!constantTimeEquals(header, expected)) {
    logger.warn('rejected an unauthorised tournament scheduler call');
    throw errors.auth('Not authorised.');
  }
}

/** Pulls a token out of `Authorization: Bearer <token>`. */
function bearer(header: string | null): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/**
 * Length-safe, timing-safe comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing signal — so both sides are hashed to a fixed width first by padding
 * into equal-length buffers, and the length is compared separately as part of
 * the result rather than as an early return.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  const width = Math.max(left.length, right.length);
  const paddedLeft = Buffer.alloc(width);
  const paddedRight = Buffer.alloc(width);
  left.copy(paddedLeft);
  right.copy(paddedRight);

  return timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
}

export const dynamic = 'force-dynamic';
