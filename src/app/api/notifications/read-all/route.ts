import { notificationController } from '@/controllers/notification.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `PATCH /api/notifications/read-all`
 *
 * Clears the caller's whole backlog in one write, and pushes the new count to
 * their other devices — clearing the badge on a phone must clear it on the
 * tablet too.
 *
 * Next resolves this static segment ahead of the sibling dynamic one, so
 * `read-all` is never read as a notification id.
 */
export const PATCH = withErrorHandling((request: Request) =>
  notificationController.markAllRead(request),
);

export const dynamic = 'force-dynamic';
