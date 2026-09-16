import { connectToDatabase } from '@/config/database';
import { optionalUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `GET /api/tournaments`
 *
 * Today's tournaments — at most three, in the order they happen.
 *
 * ## Why "at most" and not "exactly"
 *
 * Three is what a normal day has, and the unique index on
 * `{tournamentDate, dailySlot, isAutomatic}` is what stops there ever being a
 * fourth. But a day can honestly have fewer: a deployment that first booted
 * this afternoon never created a morning tournament, because a tournament
 * whose registration window closed before it existed is one nobody could have
 * joined. Returning two cards that day is the truth; inventing a third would
 * not be.
 *
 * ## Why finished tournaments are included
 *
 * Because the morning tournament's result is the most interesting thing on
 * this screen at lunchtime, and because the player who won it should be able
 * to find it. A day is a schedule, not a queue — nothing is removed from it
 * when it ends.
 *
 * ## Why authentication is optional
 *
 * The schedule is public: what is on, when, how full it is and who won are the
 * same facts for everybody. Signing in adds the `viewer` block on each row —
 * whether *you* are registered for that one, whether you may check in, which
 * match is waiting for you — which is the only per-caller part of the
 * response, and is computed per tournament because a player may be in more
 * than one of them.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await optionalUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user?.id));

  await connectToDatabase();

  return ok(await autoTournamentService.listToday(user?.id ?? null));
});

export const dynamic = 'force-dynamic';
