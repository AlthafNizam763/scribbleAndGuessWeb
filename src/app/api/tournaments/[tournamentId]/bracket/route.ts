import { connectToDatabase } from '@/config/database';
import { optionalUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `GET /api/tournaments/:id/bracket`
 *
 * The draw: every round, every pairing, every result so far.
 *
 * ## What is withheld, and from whom
 *
 * Room codes. A match carries the code of a protected room, and the only
 * people with any business knowing it are the two playing in it — so it is
 * blanked for everybody else. The room itself refuses outsiders regardless, so
 * this is the second of two locks rather than the only one; two, because a
 * code handed to a spectator is a code they can pass on.
 */
type Context = { params: Promise<{ tournamentId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const user = await optionalUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user?.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;

  return ok(await autoTournamentService.bracket(tournamentId, user?.id ?? null));
});

export const dynamic = 'force-dynamic';
