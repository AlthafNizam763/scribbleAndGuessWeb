import { gamePlatformController } from '@/controllers/game_platform.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

type Context = { params: Promise<{ gameId: string }> };
export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId } = await context.params; return gamePlatformController.rooms(request, gameId);
});
export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId } = await context.params; return gamePlatformController.createRoom(request, gameId);
});
export const dynamic = 'force-dynamic';
