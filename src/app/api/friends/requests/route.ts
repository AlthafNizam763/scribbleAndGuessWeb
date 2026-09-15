import { friendController } from '@/controllers/friend.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `POST /api/friends/requests` — ask somebody to be your friend.
 *
 * The body names the receiver and nothing else. The sender is the token, so
 * there is no field with which to send a request as somebody else.
 */
export const POST = withErrorHandling((request: Request) => friendController.send(request));

export const dynamic = 'force-dynamic';
