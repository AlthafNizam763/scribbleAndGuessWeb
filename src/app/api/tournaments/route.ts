import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { tournamentService } from '@/services/tournament.service';

/**
 * `GET /api/tournaments`
 *
 * What is on now and what is coming up, soonest first. Each row carries the
 * caller's own registration state, so the list can draw the right button per
 * row without a request per row.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await requireUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user.id));

  await connectToDatabase();

  return ok({ items: await tournamentService.list(user.id) });
});

export const dynamic = 'force-dynamic';
