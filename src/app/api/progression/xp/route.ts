import { progressionController } from '@/controllers/progression.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/progression/xp?page=&limit=`
 *
 * The caller's own XP history, newest first. Not readable for anybody else:
 * it is an itemised record of when somebody played and for how long, which is
 * a different thing from the level it adds up to.
 */
export const GET = withErrorHandling((request: Request) =>
  progressionController.xpHistory(request),
);

export const dynamic = 'force-dynamic';
