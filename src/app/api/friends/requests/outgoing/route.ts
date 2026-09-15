import { friendController } from '@/controllers/friend.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/friends/requests/outgoing` — who the caller is waiting on. */
export const GET = withErrorHandling((request: Request) => friendController.outgoing(request));

export const dynamic = 'force-dynamic';
