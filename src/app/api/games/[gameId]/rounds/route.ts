import { gameController } from '@/controllers/game.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/games/:gameId/rounds` — finished rounds only. */
type Context = { params: Promise<{ gameId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId } = await context.params;
  return gameController.rounds(request, gameId);
});

export const dynamic = 'force-dynamic';
