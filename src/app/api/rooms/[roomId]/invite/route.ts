import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `/api/rooms/:roomId/invite`
 *
 * `GET` lists the caller's friends annotated for this room — online, seated,
 * already asked, invitable — which is what the invite sheet draws.
 * `POST` sends one invitation.
 *
 * Both require the caller to be seated in the room. `roomId` accepts an id or
 * a room code, like every other room route.
 */
type Context = { params: Promise<{ roomId: string }> };

export const GET = withErrorHandling(async (request: Request, context: Context) => {
  const { roomId } = await context.params;
  return roomController.inviteCandidates(request, roomId);
});

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { roomId } = await context.params;
  return roomController.invite(request, roomId);
});

export const dynamic = 'force-dynamic';
