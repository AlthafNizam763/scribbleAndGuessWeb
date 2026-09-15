import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/rooms/:roomId/members` — who is seated, for a member.
 *
 * Not public: the player list says who is in the building. A caller who is not
 * in the room gets the same refusal as one asking about a room that does not
 * exist.
 */
type Context = { params: Promise<{ roomId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { roomId } = await context.params;
  return roomController.members(request, roomId);
});

export const dynamic = 'force-dynamic';
