import { replayController } from '@/controllers/replay.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/games/:gameId/replays/:turnNumber`
 *
 * One finished turn, with its strokes and its word. A turn that has not ended
 * answers `NOT_FOUND` — the same answer a turn that never existed gets, so
 * this cannot be used to probe for the live round's answer.
 */
type Context = { params: Promise<{ gameId: string; turnNumber: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId, turnNumber } = await context.params;
  return replayController.get(request, gameId, turnNumber);
});

export const dynamic = 'force-dynamic';
