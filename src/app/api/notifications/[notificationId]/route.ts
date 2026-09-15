import { notificationController } from '@/controllers/notification.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `DELETE /api/notifications/:notificationId`
 *
 * Removes one row from the caller's own inbox. Scoped by owner in the delete
 * filter, for the same reason the read route is.
 */
type Context = { params: Promise<{ notificationId: string }> };

export const DELETE = withErrorHandling(async (request: Request, context: Context) => {
  const { notificationId } = await context.params;
  return notificationController.remove(request, notificationId);
});

export const dynamic = 'force-dynamic';
