import { gamePlatformController } from '@/controllers/game_platform.controller';
import { withErrorHandling } from '@/middleware/error.middleware';
type Context = { params: Promise<{ gameId: string; roomId: string }> };
export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId, roomId } = await context.params; return gamePlatformController.ready(request, gameId, roomId);
});
export const dynamic = 'force-dynamic';
