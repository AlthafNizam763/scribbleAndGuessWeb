import type { NextResponse } from 'next/server';

import { ok } from '@/middleware/error.middleware';
import { requireUser } from '@/middleware/auth.middleware';
import { parseBody } from '@/middleware/validation.middleware';
import { userService } from '@/services/user.service';
import { updateProfileSchema } from '@/validators/auth.validator';

/** Profile endpoints (brief section 8). */
export const userController = {
  /** `GET /api/users/me` */
  async me(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    return ok({ user: await userService.me(user.id) });
  },

  /**
   * `PATCH /api/users/me`
   *
   * The schema names only `username`, `avatarId` and `avatarColorIndex`, so a
   * body carrying `totalScore` or `gamesWon` has those keys stripped before
   * the service is reached. There is no path from this request to a stat.
   */
  async updateMe(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    const patch = await parseBody(request, updateProfileSchema);

    return ok({ user: await userService.updateProfile(user.id, patch) });
  },
};
