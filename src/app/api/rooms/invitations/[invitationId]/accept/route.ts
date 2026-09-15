import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `POST /api/rooms/invitations/:invitationId/accept`
 *
 * Invitee only, checked against the loaded row rather than against anything
 * the caller sent: an invitation id is not a capability, so guessing one gets
 * a refusal rather than somebody else's seat.
 *
 * Every room check runs again here. The invitation answers "were you invited";
 * the room answers whether there is still space, whether the game has started
 * and whether it exists at all.
 */
type Context = { params: Promise<{ invitationId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { invitationId } = await context.params;
  return roomController.acceptInvitation(request, invitationId);
});

export const dynamic = 'force-dynamic';
