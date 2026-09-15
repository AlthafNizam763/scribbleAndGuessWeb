import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `POST /api/rooms/invitations/:invitationId/reject` — decline. Invitee only. */
type Context = { params: Promise<{ invitationId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { invitationId } = await context.params;
  return roomController.rejectInvitation(request, invitationId);
});

export const dynamic = 'force-dynamic';
