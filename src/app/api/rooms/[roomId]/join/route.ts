import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `POST /api/rooms/:roomId/join` — take a seat in a named room.
 *
 * The counterpart to `POST /api/rooms/join`, which joins by code in the body.
 * This one names the room in the path, which is what the public room list and
 * the invitation rows carry.
 */
type Context = { params: Promise<{ roomId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { roomId } = await context.params;
  return roomController.joinById(request, roomId);
});

export const dynamic = 'force-dynamic';
