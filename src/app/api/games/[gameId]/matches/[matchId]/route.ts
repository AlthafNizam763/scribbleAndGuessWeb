import { gamePlatformController } from '@/controllers/game_platform.controller';
import { withErrorHandling } from '@/middleware/error.middleware';
type Context = { params: Promise<{ gameId: string; matchId: string }> };
export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId, matchId } = await context.params; return gamePlatformController.match(request, gameId, matchId);
});
export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { gameId, matchId } = await context.params; return gamePlatformController.action(request, gameId, matchId);
});
export const dynamic = 'force-dynamic';
