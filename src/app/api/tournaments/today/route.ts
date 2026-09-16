import { connectToDatabase } from '@/config/database';
import { optionalUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { autoTournamentService } from '@/services/tournament/auto.service';
import { isDayKey } from '@/utils/dayKey';

/**
 * `GET /api/tournaments/today`
 *
 * The same answer as `GET /api/tournaments`, at a path that says what it
 * means — and the one place another day can be asked for.
 *
 * ## Why an alias exists at all
 *
 * Because `/api/tournaments` reads like "all tournaments" and returns one
 * day's. A client written against the obvious name should get the obvious
 * thing, and a reader of the code should not have to know that the bare path
 * means today. Both go through the same service method, so there is no second
 * implementation to disagree.
 *
 * ## `?date=YYYY-MM-DD`
 *
 * Yesterday's results, or tomorrow's schedule. Only the format is validated,
 * not the range: a day with nothing in it returns an empty list, which is the
 * correct answer for a date before this feature existed and for one far enough
 * ahead that the organiser has not published it yet.
 *
 * The date is read in the deployment's timezone, and the response says which
 * zone that was — a client must not decide from its own clock which day it is
 * looking at.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await optionalUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user?.id));

  await connectToDatabase();

  const asked = new URL(request.url).searchParams.get('date');
  const viewerId = user?.id ?? null;

  if (asked && isDayKey(asked)) {
    return ok(await autoTournamentService.listDay(asked, viewerId));
  }

  return ok(await autoTournamentService.listToday(viewerId));
});

export const dynamic = 'force-dynamic';
