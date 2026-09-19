import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { isGameId, type GameId } from '@/games/game.types';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { discoveryService } from '@/services/discovery.service';

/** Largest page Quick Match will return, however large a `limit` is asked for. */
const MAX_LIMIT = 50;

/** What it returns when nobody says. */
const DEFAULT_LIMIT = 30;

/** Quick Match: joinable public rooms across every game. */
export const discoveryController = {
  /**
   * `GET /api/rooms/discover`
   *
   * Query:
   * - `limit` — rows to return, 1..50. Clamped rather than rejected: a client
   *   asking for 500 wants "as many as I can have", and refusing the whole
   *   request over it would be pedantry.
   * - `games` — comma-separated game ids to restrict to. Unknown ids are
   *   dropped rather than refused, so a client built against a newer catalogue
   *   degrades to the games this server does have instead of failing outright.
   */
  async publicRooms(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('publicRooms', clientIdentity(request, user.id));

    await connectToDatabase();

    const url = new URL(request.url);
    const limit = clamp(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1, MAX_LIMIT);
    const gameIds = (url.searchParams.get('games') ?? '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter((value): value is GameId => isGameId(value));

    return ok(await discoveryService.publicRooms(user, { limit, gameIds }));
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
