import { connectToDatabase } from '@/config/database';
import { optionalUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `GET /api/tournaments/active`
 *
 * The tournaments being played right now.
 *
 * A narrower read than the slot listing, for a client that wants "what is
 * running" without the empty slots and the ones still taking entries — a home
 * screen strip, say. The slot listing remains the one the tournament screen
 * uses, because it is the one that can draw all three cards.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await optionalUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user?.id));

  await connectToDatabase();

  return ok({ items: await autoTournamentService.listActive(user?.id ?? null) });
});

export const dynamic = 'force-dynamic';
