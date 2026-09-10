import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `POST /api/rooms/:roomId/leave` — give up a seat. */
type Context = { params: Promise<{ roomId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { roomId } = await context.params;
  return roomController.leave(request, roomId);
});

export const dynamic = 'force-dynamic';
