import { userController } from '@/controllers/user.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/users/search?q=&limit=` — find players by the start of their name.
 *
 * Rate-limited per caller and hard-capped at twenty-five results. The caller
 * and everyone a block stands between are excluded, so a blocked user is
 * simply absent from the world rather than visibly hidden.
 */
export const GET = withErrorHandling((request: Request) => userController.search(request));

export const dynamic = 'force-dynamic';
