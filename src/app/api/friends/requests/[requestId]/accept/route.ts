import { friendController } from '@/controllers/friend.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `POST /api/friends/requests/:requestId/accept`
 *
 * Receiver only. Creates the friendship and tells the sender.
 *
 * The caller's right to act is checked against the loaded row, not against
 * anything they sent: a request id is not a capability, so guessing one gets a
 * refusal rather than somebody else's friendship.
 */
type Context = { params: Promise<{ requestId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { requestId } = await context.params;
  return friendController.accept(request, requestId);
});

export const dynamic = 'force-dynamic';
