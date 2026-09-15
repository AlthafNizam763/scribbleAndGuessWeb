import { friendController } from '@/controllers/friend.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/friends?page=&limit=` — the caller's accepted friends. */
export const GET = withErrorHandling((request: Request) => friendController.list(request));

export const dynamic = 'force-dynamic';
