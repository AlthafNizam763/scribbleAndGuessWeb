import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { tournamentService } from '@/services/tournament.service';

/**
 * `GET /api/tournaments/events`
 *
 * The older *points* tournaments: scheduled windows with their own
 * leaderboards, fed by ordinary ranked matches.
 *
 * ## Why this moved
 *
 * It used to be `GET /api/tournaments`. That path now serves the automatic
 * knockout slots, which is what a player means when they open the tournament
 * screen — three cards, join one, play. The points events are a different
 * feature with different rows and a different shape, and they kept working
 * under a name that says what they are.
 *
 * Nothing about the feature changed: the same list, the same registration
 * state per row, and the same board at
 * `GET /api/tournaments/:id/board`.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await requireUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user.id));

  await connectToDatabase();

  return ok({ items: await tournamentService.list(user.id) });
});

export const dynamic = 'force-dynamic';
