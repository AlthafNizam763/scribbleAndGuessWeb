import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `POST /api/tournaments/:id/check-in`
 *
 * "I am still here." The two-minute question between registration closing and
 * the bracket being drawn.
 *
 * ## Why this exists at all
 *
 * Because a knockout pairing needs both players present. Ten minutes of
 * registration is long enough that somebody who signed up at the start has put
 * their phone down, and a bracket drawn from registrations would spend its
 * first round handing out walkovers to people who stayed. Check-in is what the
 * bracket is actually drawn from — and it is what the bot fill counts, so the
 * AI players make up a real shortfall rather than a theoretical one.
 *
 * Checking in twice is a no-op. Checking in after the scheduler has already
 * written the caller off as a no-show is refused honestly rather than
 * resurrecting them into a draw that has been made.
 */
type Context = { params: Promise<{ tournamentId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser(request);
  enforceHttpLimit('joinRoom', clientIdentity(request, user.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;

  return ok({ tournament: await autoTournamentService.checkIn(tournamentId, user.id) });
});

export const dynamic = 'force-dynamic';
