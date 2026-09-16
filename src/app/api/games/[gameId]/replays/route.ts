import { replayController } from '@/controllers/replay.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/games/:gameId/replays`
 *
 * Every finished turn of a match, as metadata. Strokes come from the per-turn
 * route beside this one — the list is a menu, not a download.
 */
type Context = { params: Promise<{ gameId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId } = await context.params;
  return replayController.list(request, gameId);
});

export const dynamic = 'force-dynamic';
