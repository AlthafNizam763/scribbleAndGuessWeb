import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { tournamentService } from '@/services/tournament.service';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `POST /api/tournaments/:id/register` — take a place.
 * `DELETE /api/tournaments/:id/register` — give it back.
 *
 * ## What registering is refused for
 *
 * Registration being closed, the tournament being full, and — the one worth
 * spelling out — the caller already being in another live tournament. A player
 * in two brackets would eventually be called to two matches at the same
 * moment, and one of them would have to be a walkover. Refusing at the door is
 * kinder than eliminating somebody from something they had no way to attend.
 *
 * Registering twice is a no-op rather than an error. The unique index decides,
 * and the caller is registered either way.
 *
 * ## Why withdrawal only works during registration
 *
 * Past that the roster has been counted — by the bot fill and then by the
 * seeder — and removing somebody would leave a hole in a draw that has already
 * been made. Somebody who changes their mind later simply does not check in,
 * which the tournament already handles gracefully.
 */
type Context = { params: Promise<{ tournamentId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser(request);
  enforceHttpLimit('joinRoom', clientIdentity(request, user.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;

  // The automatic system first; a points event is the fallback, exactly as on
  // the read route above.
  const auto = await autoTournamentService.find(tournamentId, user.id);
  if (auto) {
    return ok({ tournament: await autoTournamentService.register(tournamentId, user) });
  }

  await tournamentService.register(tournamentId, user.id);
  return ok({ tournament: await tournamentService.get(tournamentId, user.id) });
});

export const DELETE = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser(request);
  enforceHttpLimit('joinRoom', clientIdentity(request, user.id));

  await connectToDatabase();

  const { tournamentId } = await context.params;

  return ok({ tournament: await autoTournamentService.withdraw(tournamentId, user.id) });
});

export const dynamic = 'force-dynamic';
