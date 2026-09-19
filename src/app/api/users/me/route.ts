import { userController } from '@/controllers/user.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/users/me` — the signed-in player's profile and lifetime stats. */
export const GET = withErrorHandling((request: Request) => userController.me(request));

/** `PATCH /api/users/me` — change the username or avatar. Nothing else. */
export const PATCH = withErrorHandling((request: Request) => userController.updateMe(request));

/**
 * `DELETE /api/users/me` — delete the caller's own account.
 *
 * No parameter names a user, so there is no shape of this request that deletes
 * somebody else's. What it does is described in `accountDeletion.service.ts`:
 * everything personal is purged, and the row survives as a tombstone so other
 * players' match history still renders a name where a person was.
 *
 * Irreversible. The client confirms before calling it.
 */
export const DELETE = withErrorHandling((request: Request) => userController.deleteMe(request));

export const dynamic = 'force-dynamic';
