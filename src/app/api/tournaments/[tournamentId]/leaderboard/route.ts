import { connectToDatabase } from '@/config/database';
import { optionalUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `GET /api/tournaments/:id/leaderboard`
 *
 * How everybody placed.
 *
 * ## Why a knockout's leaderboard is a placement table
 *
 * A points tournament has a running total to rank by. A knockout does not —
 * the only thing it produces is how far each player got. So the ordering is by
 * depth: the winner, then the losing finalist, then the semi-finalists, and so
 * on, with seed as the tie-break so the table is stable between reads.
 *
 * AI players appear here like anybody else, flagged as AI. They do not appear
 * on the world or friends leaderboards, which are about people.
 */
type Context = { params: Promise<{ tournamentId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const user = await optionalUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user?.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;

  return ok(await autoTournamentService.leaderboard(tournamentId, user?.id ?? null));
});

export const dynamic = 'force-dynamic';
