import { notificationController } from '@/controllers/notification.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/notifications?page=&limit=&unreadOnly=`
 *
 * The caller's own inbox, newest first, with the unread badge alongside so the
 * client never needs a second request to draw the dot.
 */
export const GET = withErrorHandling((request: Request) => notificationController.list(request));

export const dynamic = 'force-dynamic';
