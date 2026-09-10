import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { connectToDatabase } from '@/config/database';
import { optionalUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { parseQuery } from '@/middleware/validation.middleware';
import { leaderboardService } from '@/services/leaderboard.service';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).catch(50).default(50),
  page: z.coerce.number().int().min(1).catch(1).default(1),
});

/**
 * The leaderboard.
 *
 * Authentication is optional: the table is public, and requiring a token to
 * read it would mean the app could not show it on a first run. A caller who
 * *is* signed in gets their own rank alongside the page, which is the number
 * they actually came for and which would otherwise take a second request and a
 * client-side scan.
 */
export const leaderboardController = {
  /** `GET /api/leaderboard?limit=50&page=1` */
  async top(request: Request): Promise<NextResponse> {
    const user = await optionalUser(request);
    await connectToDatabase();

    const { limit, page } = parseQuery(request, querySchema);
    const result = await leaderboardService.top({ limit, page });

    const self = user ? result.entries.find((entry) => entry.playerId === user.id) : undefined;

    return ok({
      entries: result.entries,
      total: result.total,
      page: result.page,
      limit: result.limit,
      self: self ?? null,
    });
  },
};
