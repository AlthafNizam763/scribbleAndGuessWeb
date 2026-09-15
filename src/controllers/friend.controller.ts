import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseBody, parseQuery } from '@/middleware/validation.middleware';
import { friendService, listPaging } from '@/services/friend.service';
import {
  objectIdSchema,
  pageQuerySchema,
  sendFriendRequestSchema,
} from '@/validators/social.validator';

/**
 * Friend requests and friendships (brief sections 3 and 7).
 *
 * ## Identity comes from the token, always
 *
 * Every handler below starts with `requireUser` and uses `user.id` as the
 * actor. No route reads a sender, an owner or a friendship holder from the
 * body or the path — the only id a caller supplies is the *other* party, and
 * the service checks the caller's right to act on the row it loads. A request
 * id is not a capability: guessing one gets you `NOT_ROOM_MEMBER`, not
 * somebody else's friendship.
 *
 * ## Rate limits
 *
 * Sending is limited hardest, because it is the only action here that puts
 * something in a stranger's list. Everything else acts on a relationship that
 * already exists and shares the looser `friendAction` bucket.
 */
export const friendController = {
  /** `POST /api/friends/requests` */
  async send(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('friendRequest', clientIdentity(request, user.id));

    await connectToDatabase();

    const { receiverId } = await parseBody(request, sendFriendRequestSchema);

    return ok({ request: await friendService.sendRequest(user.id, receiverId) }, 201);
  },

  /** `GET /api/friends/requests/incoming?page=&limit=` */
  async incoming(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const { page, limit } = listPaging(parseQuery(request, pageQuerySchema));

    return ok(await friendService.listIncoming(user.id, page, limit));
  },

  /** `GET /api/friends/requests/outgoing?page=&limit=` */
  async outgoing(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const { page, limit } = listPaging(parseQuery(request, pageQuerySchema));

    return ok(await friendService.listOutgoing(user.id, page, limit));
  },

  /** `POST /api/friends/requests/:requestId/accept` */
  async accept(request: Request, requestId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('friendAction', clientIdentity(request, user.id));

    await connectToDatabase();

    const id = objectIdSchema.parse(requestId);

    return ok(await friendService.accept(user.id, id));
  },

  /** `POST /api/friends/requests/:requestId/reject` */
  async reject(request: Request, requestId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('friendAction', clientIdentity(request, user.id));

    await connectToDatabase();

    await friendService.reject(user.id, objectIdSchema.parse(requestId));

    return ok({ rejected: true });
  },

  /** `POST /api/friends/requests/:requestId/cancel` */
  async cancel(request: Request, requestId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('friendAction', clientIdentity(request, user.id));

    await connectToDatabase();

    await friendService.cancel(user.id, objectIdSchema.parse(requestId));

    return ok({ cancelled: true });
  },

  /** `GET /api/friends?page=&limit=` */
  async list(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const { page, limit } = listPaging(parseQuery(request, pageQuerySchema));

    return ok(await friendService.listFriends(user.id, page, limit));
  },

  /** `DELETE /api/friends/:userId` */
  async remove(request: Request, userId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('friendAction', clientIdentity(request, user.id));

    await connectToDatabase();

    await friendService.removeFriend(user.id, objectIdSchema.parse(userId));

    return ok({ removed: true });
  },
};
