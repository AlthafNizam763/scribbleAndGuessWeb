import { friendController } from '@/controllers/friend.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `DELETE /api/friends/:userId` — end a friendship.
 *
 * Symmetric: one row holds the pair, so removing it removes the friendship for
 * both people at once and cannot leave one of them still seeing the other.
 *
 * Next resolves the static `/api/friends/requests` segment ahead of this
 * dynamic one, so `requests` is never read as a user id.
 */
type Context = { params: Promise<{ userId: string }> };

export const DELETE = withErrorHandling(async (request: Request, context: Context) => {
  const { userId } = await context.params;
  return friendController.remove(request, userId);
});

export const dynamic = 'force-dynamic';
