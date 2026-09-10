import { gameController } from '@/controllers/game.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/games/:gameId` — a match's progress, or its full history once over. */
type Context = { params: Promise<{ gameId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId } = await context.params;
  return gameController.get(request, gameId);
});

export const dynamic = 'force-dynamic';
