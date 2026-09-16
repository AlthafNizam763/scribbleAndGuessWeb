import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { statsService } from '@/services/stats.service';
import { objectIdSchema } from '@/validators/social.validator';

/**
 * `GET /api/users/:userId/stats`
 *
 * One player's full career record. Public, because these are the same numbers
 * a leaderboard already shows — in more detail. What is not here is anything
 * private: no email, no locality beyond what the profile publishes, and no XP
 * history, which is an itemised log of when somebody played and stays their
 * own (see `/api/progression/xp`).
 *
 * `me` is accepted in place of an id, so a client need not know its own.
 */
type Context = { params: Promise<{ userId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user.id));

  await connectToDatabase();

  const { userId } = await context.params;
  const target = userId === 'me' ? user.id : objectIdSchema.parse(userId);

  return ok({ stats: await statsService.forUser(target) });
});

export const dynamic = 'force-dynamic';
