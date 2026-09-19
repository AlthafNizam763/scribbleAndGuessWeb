import { gameController } from '@/controllers/game.controller';
import { gamePlatformController } from '@/controllers/game_platform.controller';
import { isGameId } from '@/games/game.types';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/games/:gameId` — a match's progress, or its full history once over. */
type Context = { params: Promise<{ gameId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId } = await context.params;
  // Existing Scribble match history uses a Mongo id here. Platform game ids
  // are named constants, so both APIs can coexist without a breaking path.
  if (isGameId(gameId)) return gamePlatformController.detail(request, gameId);
  return gameController.get(request, gameId);
});

export const dynamic = 'force-dynamic';
