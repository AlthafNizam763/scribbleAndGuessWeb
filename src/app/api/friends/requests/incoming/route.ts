import { friendController } from '@/controllers/friend.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/friends/requests/incoming` — who is waiting on the caller. */
export const GET = withErrorHandling((request: Request) => friendController.incoming(request));

export const dynamic = 'force-dynamic';
