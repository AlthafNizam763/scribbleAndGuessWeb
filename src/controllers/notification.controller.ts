import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseBody, parseQuery } from '@/middleware/validation.middleware';
import { deviceTokenService } from '@/services/deviceToken.service';
import { notificationPaging, notificationService } from '@/services/notification.service';
import {
  deviceTokenRemovalSchema,
  deviceTokenSchema,
  notificationQuerySchema,
} from '@/validators/notification.validator';
import { objectIdSchema } from '@/validators/social.validator';

/**
 * The notification centre's REST surface.
 *
 * ## The inbox is the token's, never the path's
 *
 * Every handler starts with `requireUser` and passes `user.id` down as the
 * owner. No route here reads a recipient from anywhere else, so a notification
 * id is not a capability: presenting somebody else's id gets `NOT_FOUND`,
 * which is the same answer an id that never existed gets. That indistinguish-
 * ability is deliberate — otherwise the read endpoint would be a way to probe
 * whether a given row exists.
 *
 * ## There is no create endpoint
 *
 * Notifications are written by services, from events that have already
 * happened. Exposing a create route would let any client put a row in any
 * inbox, which is the whole of what a spam feature would need.
 */
export const notificationController = {
  /** `GET /api/notifications?page=&limit=&unreadOnly=` */
  async list(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('notificationRead', clientIdentity(request, user.id));

    await connectToDatabase();

    const query = parseQuery(request, notificationQuerySchema);
    const { page, limit } = notificationPaging(query);

    return ok(await notificationService.list(user.id, page, limit, query.unreadOnly));
  },

  /** `PATCH /api/notifications/:id/read` */
  async markRead(request: Request, notificationId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('notificationAction', clientIdentity(request, user.id));

    await connectToDatabase();

    const id = objectIdSchema.parse(notificationId);

    return ok(await notificationService.markRead(user.id, id));
  },

  /** `PATCH /api/notifications/read-all` */
  async markAllRead(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('notificationAction', clientIdentity(request, user.id));

    await connectToDatabase();

    return ok(await notificationService.markAllRead(user.id));
  },

  /** `DELETE /api/notifications/:id` */
  async remove(request: Request, notificationId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('notificationAction', clientIdentity(request, user.id));

    await connectToDatabase();

    const id = objectIdSchema.parse(notificationId);

    return ok(await notificationService.remove(user.id, id));
  },

  /**
   * `POST /api/notifications/device-token`
   *
   * Records the handset the caller is holding, so a tournament check-in can
   * reach them with the app closed.
   *
   * The owner is `user.id` and never a field of the body. That is the whole of
   * the authorisation story here: a client can register a device to itself and
   * to nobody else, so the endpoint cannot be used to redirect somebody else's
   * notifications or to discover whether a given user exists.
   */
  async registerDevice(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('notificationAction', clientIdentity(request, user.id));

    await connectToDatabase();

    const body = await parseBody(request, deviceTokenSchema);

    return ok(
      await deviceTokenService.register({
        userId: user.id,
        token: body.token,
        platform: body.platform,
        deviceId: body.deviceId,
      }),
    );
  },

  /**
   * `DELETE /api/notifications/device-token`
   *
   * Sign-out, from this device's point of view. Scoped to the caller, so a
   * token belonging to somebody else silences nothing — and the response does
   * not say which of the two happened.
   */
  async unregisterDevice(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('notificationAction', clientIdentity(request, user.id));

    await connectToDatabase();

    const body = await parseBody(request, deviceTokenRemovalSchema);

    return ok(await deviceTokenService.unregister(user.id, body.token));
  },
};
