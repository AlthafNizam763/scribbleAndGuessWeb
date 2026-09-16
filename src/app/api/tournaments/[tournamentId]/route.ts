import { connectToDatabase } from '@/config/database';
import { optionalUser, requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { tournamentService } from '@/services/tournament.service';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `GET /api/tournaments/:id` — one tournament.
 *
 * ## Why this route serves two features
 *
 * Two collections hold things called tournaments: the automatic knockout cups,
 * and the older points events. Their ids are distinct — they are different
 * collections — so one path can serve both by trying the newer one first and
 * falling through.
 *
 * The alternative was to move the points events to a path of their own, which
 * would have broken every client already asking for one by id. Falling through
 * costs one extra lookup on a route nobody calls in a loop, and means no
 * client had to be updated to keep working.
 *
 * The two responses have different shapes, and deliberately so: a client
 * knows which kind it asked for, because it got the id from a listing that
 * said which.
 */
type Context = { params: Promise<{ tournamentId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const viewer = await optionalUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, viewer?.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;

  const auto = await autoTournamentService.find(tournamentId, viewer?.id ?? null);
  if (auto) return ok({ tournament: auto });

  // Not one of ours. It may be a points event — but those require a signed-in
  // caller, because every row carries that caller's registration state.
  const user = await requireUser(request);
  return ok({ tournament: await tournamentService.get(tournamentId, user.id) });
});

export const dynamic = 'force-dynamic';
