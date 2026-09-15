import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseQuery } from '@/middleware/validation.middleware';
import { blockPaging, blockService } from '@/services/block.service';
import { objectIdSchema, pageQuerySchema } from '@/validators/social.validator';

/**
 * Blocking (brief section 6).
 *
 * ## Ownership is the token, not the path
 *
 * The `:userId` in these routes is always the person being blocked or
 * unblocked. The blocker is always `user.id` from the verified token, so there
 * is no way to spell a request that lifts somebody else's block or plants one
 * in their name.
 *
 * ## The list is the caller's own
 *
 * `GET /api/blocks` returns who *you* have blocked. There is deliberately no
 * endpoint for "who has blocked me", and none of these responses reveals a
 * block to the person it was placed on — the blocked party's view of a profile
 * is identical to a stranger's.
 */
export const blockController = {
  /** `POST /api/blocks/:userId` */
  async block(request: Request, userId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('friendAction', clientIdentity(request, user.id));

    await connectToDatabase();

    return ok(await blockService.block(user.id, objectIdSchema.parse(userId)), 201);
  },

  /** `DELETE /api/blocks/:userId` */
  async unblock(request: Request, userId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('friendAction', clientIdentity(request, user.id));

    await connectToDatabase();

    await blockService.unblock(user.id, objectIdSchema.parse(userId));

    return ok({ unblocked: true });
  },

  /** `GET /api/blocks?page=&limit=` */
  async list(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const { page, limit } = blockPaging(parseQuery(request, pageQuerySchema));

    return ok(await blockService.list(user.id, page, limit));
  },
};
