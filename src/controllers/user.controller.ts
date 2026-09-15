import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { ok } from '@/middleware/error.middleware';
import { requireUser } from '@/middleware/auth.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseBody, parseQuery } from '@/middleware/validation.middleware';
import { userService } from '@/services/user.service';
import { updateProfileSchema } from '@/validators/auth.validator';
import {
  localitySchema,
  objectIdSchema,
  searchQuerySchema,
} from '@/validators/social.validator';

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

  /**
   * `PATCH /api/users/me/locality`
   *
   * Sets the town this player plays from, which is what the locality
   * leaderboard groups by. Separate from the profile patch on purpose: the set
   * of fields a given endpoint can write is the security boundary, so a body
   * aimed at renaming somebody cannot also relocate them.
   *
   * The schema names a city, a region and a two-letter country code. There is
   * no field for a street, a postcode or a coordinate, here or on the user
   * document, so no request can store one.
   */
  async updateLocality(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const patch = await parseBody(request, localitySchema);

    return ok({ user: await userService.updateLocality(user.id, patch) });
  },

  /**
   * `GET /api/users/search?q=&limit=`
   *
   * Finds players by the start of their name. Rate-limited per caller because
   * an anchored case-insensitive match cannot seek in the index, and hard
   * capped at twenty-five results regardless of what was asked for.
   *
   * Each result carries its relation to the caller, so a list can draw the
   * right button per row without a request per result.
   */
  async search(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('userSearch', clientIdentity(request, user.id));

    await connectToDatabase();

    const { q, limit } = parseQuery(request, searchQuerySchema);

    return ok({ items: await userService.search(user.id, q, limit) });
  },

  /**
   * `GET /api/users/:userId/profile`
   *
   * Another player's public card, their stats, their world rank and — the
   * field the client's profile button is actually drawn from — the caller's
   * `relation` to them. Authentication is required because the relation is
   * meaningless without a caller, not because the stats are secret.
   */
  async profile(request: Request, userId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const id = objectIdSchema.parse(userId);

    return ok({ profile: await userService.publicProfile(user.id, id) });
  },
};
