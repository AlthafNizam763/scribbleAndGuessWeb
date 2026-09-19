import { gamePlatformController } from '@/controllers/game_platform.controller';
import { withErrorHandling } from '@/middleware/error.middleware';
type Context = { params: Promise<{ gameId: string }> };
export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId } = await context.params; return gamePlatformController.quickMatch(request, gameId);
});
export const dynamic = 'force-dynamic';
