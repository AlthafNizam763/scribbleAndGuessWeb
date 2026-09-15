import { notificationController } from '@/controllers/notification.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `PATCH /api/notifications/:notificationId/read`
 *
 * Owner only, and the ownership check is the update's filter rather than a
 * prior read: a stranger's id gets the same `NOT_FOUND` an id that never
 * existed gets, so this cannot be used to probe for rows.
 */
type Context = { params: Promise<{ notificationId: string }> };

export const PATCH = withErrorHandling(async (request: Request, context: Context) => {
  const { notificationId } = await context.params;
  return notificationController.markRead(request, notificationId);
});

export const dynamic = 'force-dynamic';
