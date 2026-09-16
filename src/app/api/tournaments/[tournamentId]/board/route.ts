import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseQuery } from '@/middleware/validation.middleware';
import { tournamentService } from '@/services/tournament.service';
import { pageQuerySchema } from '@/validators/social.validator';

/**
 * `GET /api/tournaments/:tournamentId/board?page=&limit=`
 *
 * The event's own leaderboard. Ranks are absolute within the tournament rather
 * than within the page, so a row means the same thing however it was paged to.
 */
type Context = { params: Promise<{ tournamentId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;
  const { page, limit } = parseQuery(request, pageQuerySchema);

  return ok(
    await tournamentService.board({ tournamentId, viewerId: user.id, page, limit }),
  );
});

export const dynamic = 'force-dynamic';
