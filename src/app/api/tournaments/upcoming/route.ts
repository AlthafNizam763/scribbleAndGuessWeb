import { connectToDatabase } from '@/config/database';
import { optionalUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `GET /api/tournaments/upcoming`
 *
 * The tournaments a player could still get into: taking registrations, or in
 * check-in, or created and about to open.
 *
 * Each row carries the caller's own `viewer` block, so a list of three can
 * draw the right button on each without a request per row — including the
 * reason a player who is already in one cannot join the others.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await optionalUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user?.id));

  await connectToDatabase();

  return ok({ items: await autoTournamentService.listUpcoming(user?.id ?? null) });
});

export const dynamic = 'force-dynamic';
