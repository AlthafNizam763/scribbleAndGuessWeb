import { userController } from '@/controllers/user.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/users/me` — the signed-in player's profile and lifetime stats. */
export const GET = withErrorHandling((request: Request) => userController.me(request));

/** `PATCH /api/users/me` — change the username or avatar. Nothing else. */
export const PATCH = withErrorHandling((request: Request) => userController.updateMe(request));

export const dynamic = 'force-dynamic';
