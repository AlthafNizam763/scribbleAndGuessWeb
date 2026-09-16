import { notificationController } from '@/controllers/notification.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `POST /api/notifications/device-token`
 *
 * Registers the FCM token of the device the caller is using, so a tournament
 * check-in can reach them once the app is closed. Idempotent: the client calls
 * it on every launch, after sign-in, and on every token refresh, and all three
 * land on the same upsert.
 */
export const POST = withErrorHandling((request: Request) =>
  notificationController.registerDevice(request),
);

/**
 * `DELETE /api/notifications/device-token`
 *
 * Retires one device, on sign-out. The token travels in the body rather than
 * the path so it stays out of access logs.
 */
export const DELETE = withErrorHandling((request: Request) =>
  notificationController.unregisterDevice(request),
);

export const dynamic = 'force-dynamic';
