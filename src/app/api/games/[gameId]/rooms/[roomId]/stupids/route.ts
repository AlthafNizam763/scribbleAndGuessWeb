import { gamePlatformController } from '@/controllers/game_platform.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

type Context = { params: Promise<{ gameId: string; roomId: string }> };

/** `POST /api/games/:gameId/rooms/:roomId/stupids` — seat bot players. */
export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId, roomId } = await context.params;
  return gamePlatformController.addStupids(request, gameId, roomId);
});

/** `DELETE` the same path — remove every bot from the room. */
export const DELETE = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId, roomId } = await context.params;
  return gamePlatformController.clearStupids(request, gameId, roomId);
});

export const dynamic = 'force-dynamic';
