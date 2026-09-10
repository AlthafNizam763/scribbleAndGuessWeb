import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { ok } from '@/middleware/error.middleware';
import {
  clientIdentity,
  enforceHttpLimit,
} from '@/middleware/rateLimit.middleware';
import { parseBody } from '@/middleware/validation.middleware';
import { requireUser } from '@/middleware/auth.middleware';
import { authService } from '@/services/auth.service';
import { guestLoginSchema } from '@/validators/auth.validator';

/**
 * Auth endpoints (brief section 7).
 *
 * Controllers translate between HTTP and the services and do nothing else: no
 * rules, no database, no broadcasting. That keeps the socket layer and this
 * one calling identical code for identical actions.
 */
export const authController = {
  /** `POST /api/auth/guest` */
  async guest(request: Request): Promise<NextResponse> {
    // Limited by address rather than user: there is no user yet, and account
    // creation is the one unauthenticated write this API exposes.
    enforceHttpLimit('guestLogin', clientIdentity(request));

    await connectToDatabase();

    const body = await parseBody(request, guestLoginSchema);
    const { token, user } = await authService.createGuest(body);

    return ok(
      {
        token,
        user: {
          id: user.id,
          username: user.username,
          avatarId: user.avatarId,
          avatarColorIndex: user.avatarColorIndex,
        },
      },
      201,
    );
  },

  /**
   * `GET /api/auth/session`
   *
   * Confirms a stored token is still good. The app calls this at startup so it
   * can send a player straight to the home screen instead of showing a name
   * prompt they already filled in — and so a revoked or expired token is
   * discovered before they try to create a room with it.
   */
  async session(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    return ok({ user });
  },
};
