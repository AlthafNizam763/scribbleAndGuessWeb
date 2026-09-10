import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `PATCH /api/rooms/:roomId/settings` — host-only, between games only. */
type Context = { params: Promise<{ roomId: string }> };

export const PATCH = withErrorHandling(async (request: Request, context: Context) => {
  const { roomId } = await context.params;
  return roomController.updateSettings(request, roomId);
});

export const dynamic = 'force-dynamic';
