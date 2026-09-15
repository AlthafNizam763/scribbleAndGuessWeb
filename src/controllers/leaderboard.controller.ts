import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { connectToDatabase } from '@/config/database';
import type { LeaderboardScope } from '@/constants/social.constants';
import { optionalUser, requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { parseQuery } from '@/middleware/validation.middleware';
import { leaderboardService } from '@/services/leaderboard.service';
import { pageQuerySchema, rankQuerySchema } from '@/validators/social.validator';

/**
 * The leaderboards (brief section 1).
 *
 * ## Who has to be signed in
 *
 * The world board is readable without a token: the table is public, and
 * requiring one would mean the app could not show it on a first run. A caller
 * who *is* signed in additionally gets their own rank and row.
 *
 * Friends and locality both require a token, and not merely because they are
 * personal — they are meaningless without one. "Your friends" and "your town"
 * are questions about the caller, so an anonymous request has no answer rather
 * than a public one.
 *
 * ## Scores
 *
 * Nothing on this controller writes. Every number it serves was put on a user
 * row by the end-of-match path in the game engine, and there is no request
 * body on any of these routes at all.
 */

/** `GET /api/leaderboard` — the original, unscoped shape. */
const legacyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).catch(50).default(50),
  page: z.coerce.number().int().min(1).catch(1).default(1),
});

export const leaderboardController = {
  /**
   * `GET /api/leaderboard?limit=50&page=1`
   *
   * The endpoint that existed before the scoped boards, kept at its original
   * path and in its original response shape — `entries`, `total`, `page`,
   * `limit`, `self` — so anything already reading it keeps working. It is the
   * world board underneath; new clients should call `/world` and get the
   * richer envelope.
   */
  async top(request: Request): Promise<NextResponse> {
    const user = await optionalUser(request);
    await connectToDatabase();

    const { limit, page } = parseQuery(request, legacyQuerySchema);

    const result = await leaderboardService.world({
      viewerId: user?.id ?? null,
      page,
      limit,
    });

    return ok({
      entries: result.items.map((item) => ({
        playerId: item.id,
        name: item.username,
        avatarId: item.avatarId,
        avatarColorIndex: item.avatarColorIndex,
        totalScore: item.totalScore,
        gamesPlayed: item.gamesPlayed,
        wins: item.gamesWon,
        bestRoundScore: item.bestRoundScore,
        rank: item.rank,
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
      self: result.currentUserEntry,
    });
  },

  /** `GET /api/leaderboard/world?page=&limit=` — optional authentication. */
  async world(request: Request): Promise<NextResponse> {
    const user = await optionalUser(request);
    await connectToDatabase();

    const { page, limit } = parseQuery(request, pageQuerySchema);

    return ok(await leaderboardService.world({ viewerId: user?.id ?? null, page, limit }));
  },

  /** `GET /api/leaderboard/friends?page=&limit=` */
  async friends(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const { page, limit } = parseQuery(request, pageQuerySchema);

    return ok(await leaderboardService.friends({ viewerId: user.id, page, limit }));
  },

  /** `GET /api/leaderboard/locality?page=&limit=` */
  async locality(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const { page, limit } = parseQuery(request, pageQuerySchema);

    return ok(await leaderboardService.locality({ viewerId: user.id, page, limit }));
  },

  /**
   * `GET /api/leaderboard/me/rank?scope=world|friends|locality`
   *
   * The caller's standing without a page of rows. This is what lets a client
   * show "you are 4,212nd" above a board the player is nowhere near, without
   * paging to find themselves.
   */
  async myRank(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const { scope } = parseQuery(request, rankQuerySchema);

    return ok(await leaderboardService.myRank(user.id, scope as LeaderboardScope));
  },
};

