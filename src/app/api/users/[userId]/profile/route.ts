import { userController } from '@/controllers/user.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/users/:userId/profile` — another player's public card.
 *
 * Carries their stats, their world rank and the caller's `relation` to them,
 * which is the single value the profile screen's button is drawn from.
 *
 * In Next 15 `params` is a promise, so it is awaited before use.
 */
type Context = { params: Promise<{ userId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { userId } = await context.params;
  return userController.profile(request, userId);
});

export const dynamic = 'force-dynamic';
