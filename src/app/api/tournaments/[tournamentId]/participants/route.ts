import { connectToDatabase } from '@/config/database';
import { optionalUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `GET /api/tournaments/:id/participants`
 *
 * Everybody in a tournament, in seed order once one has been drawn.
 *
 * AI players are included and flagged, never filtered out. A four-player
 * tournament that is one person and three robots must read as exactly that —
 * hiding the bots would make the roster a lie, and a roster is the one place a
 * player looks to find out who they are up against.
 */
type Context = { params: Promise<{ tournamentId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const user = await optionalUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user?.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;

  return ok({
    items: await autoTournamentService.participants(tournamentId, user?.id ?? null),
  });
});

export const dynamic = 'force-dynamic';
