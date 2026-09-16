import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { tournamentService } from '@/services/tournament.service';

/**
 * `POST /api/tournaments/:tournamentId/register`
 *
 * Registering twice is a no-op rather than an error — the unique index decides,
 * and the caller is registered either way.
 *
 * Registering while a tournament is *running* is allowed on purpose: a points
 * tournament has no pairings to disturb, and turning somebody away from a
 * weekend event because they heard about it on Saturday serves nobody.
 */
type Context = { params: Promise<{ tournamentId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser(request);
  enforceHttpLimit('joinRoom', clientIdentity(request, user.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;
  await tournamentService.register(tournamentId, user.id);

  return ok({ tournament: await tournamentService.get(tournamentId, user.id) });
});

export const dynamic = 'force-dynamic';
