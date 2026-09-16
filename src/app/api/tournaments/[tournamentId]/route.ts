import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { tournamentService } from '@/services/tournament.service';

/** `GET /api/tournaments/:tournamentId` — one event, with the caller's state. */
type Context = { params: Promise<{ tournamentId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;
  return ok({ tournament: await tournamentService.get(tournamentId, user.id) });
});

export const dynamic = 'force-dynamic';
