import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { ok } from '@/middleware/error.middleware';
import {
  clientIdentity,
  enforceHttpLimit,
} from '@/middleware/rateLimit.middleware';
import { parseBody } from '@/middleware/validation.middleware';
import { optionalUser, requireUser } from '@/middleware/auth.middleware';
import { authService } from '@/services/auth.service';
import { guestLoginSchema, loginSchema, registerSchema } from '@/validators/auth.validator';

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
          provider: user.provider,
        },
      },
      201,
    );
  },

  /**
   * `POST /api/auth/register`
   *
   * Authentication is *optional* here, and that is the whole design. Called
   * with no token it creates an account. Called with a guest's token it turns
   * that guest into an email account in place, so a player who has been
   * playing all evening keeps their scores, friends and achievements instead
   * of starting again behind a second row.
   *
   * `optionalUser` rather than `requireUser` because a bad or expired token
   * must not block a signed-out registration — it is simply treated as absent.
   */
  async register(request: Request): Promise<NextResponse> {
    enforceHttpLimit('register', clientIdentity(request));

    await connectToDatabase();

    const caller = await optionalUser(request);
    const body = await parseBody(request, registerSchema);
    const { token, user, upgraded } = await authService.register({
      existingUserId: caller?.id ?? null,
      existingProvider: caller?.provider ?? null,
      ...body,
    });

    return ok(
      {
        token,
        upgraded,
        user: {
          id: user.id,
          username: user.username,
          avatarId: user.avatarId,
          avatarColorIndex: user.avatarColorIndex,
          provider: user.provider,
        },
      },
      201,
    );
  },

  /**
   * `POST /api/auth/login`
   *
   * Rate limited by address before the body is even parsed, because the cost
   * this endpoint has to control is the *attempt*, not the work behind it.
   */
  async login(request: Request): Promise<NextResponse> {
    enforceHttpLimit('emailLogin', clientIdentity(request));

    await connectToDatabase();

    const body = await parseBody(request, loginSchema);
    const { token, user } = await authService.login(body.email, body.password);

    return ok({
      token,
      user: {
        id: user.id,
        username: user.username,
        avatarId: user.avatarId,
        avatarColorIndex: user.avatarColorIndex,
        provider: user.provider,
      },
    });
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
