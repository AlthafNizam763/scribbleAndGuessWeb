import { progressionController } from '@/controllers/progression.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/achievements?userId=`
 *
 * The whole catalogue, annotated with what the target player has unlocked.
 * Defaults to the caller; any player id is accepted, because a badge nobody
 * else can see is not a badge.
 *
 * Locked entries are returned rather than omitted — the screen is a list of
 * things to aim at, not only a trophy case.
 */
export const GET = withErrorHandling((request: Request) =>
  progressionController.achievements(request),
);

export const dynamic = 'force-dynamic';
