import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/rooms/:roomId` — a room's state, lobby summary and game state.
 *
 * `roomId` accepts a room id or a room code, because the client's lobby route
 * is `/room/:code` and it should not have to carry a second identifier.
 *
 * In Next 15 `params` is a promise, so it is awaited before use.
 */
type Context = { params: Promise<{ roomId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { roomId } = await context.params;
  return roomController.get(request, roomId);
});

export const dynamic = 'force-dynamic';
