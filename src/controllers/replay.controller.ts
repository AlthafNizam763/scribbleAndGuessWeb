import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { replayService } from '@/services/replay.service';
import { errors } from '@/utils/errors';

/**
 * Drawing replays over REST.
 *
 * ## Both routes are reads, and both are gated on the turn being over
 *
 * A replay carries the drawing and the word together, so the only thing
 * protecting the answer is that a live turn is never returned. That check
 * lives in `replayService`, not here, so the rule holds for any caller rather
 * than only for these two routes.
 *
 * ## Why the list carries no strokes
 *
 * A twelve-turn match's drawings together are megabytes. The list is a menu —
 * a player picks a turn — so it answers with metadata and the strokes come
 * from the second call, once.
 */
export const replayController = {
  /** `GET /api/games/:gameId/replays` — every finished turn, without strokes. */
  async list(request: Request, gameId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('replayRead', clientIdentity(request, user.id));

    await connectToDatabase();

    return ok(await replayService.list(gameId));
  },

  /** `GET /api/games/:gameId/replays/:turnNumber` — one turn, with strokes. */
  async get(request: Request, gameId: string, turnNumber: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('replayRead', clientIdentity(request, user.id));

    await connectToDatabase();

    const turn = Number.parseInt(turnNumber, 10);
    if (!Number.isInteger(turn) || turn < 1) {
      throw errors.validation('That is not a valid turn number.');
    }

    return ok({ replay: await replayService.get(gameId, turn) });
  },
};
