import { userController } from '@/controllers/user.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `PATCH /api/users/me/preferences` — the notification and privacy switches.
 *
 * Its own endpoint rather than part of the profile patch, for the same reason
 * the locality one is separate: the set of fields an endpoint can write is the
 * security boundary, so a request aimed at muting notifications cannot also
 * rename somebody or move them to another town.
 */
export const PATCH = withErrorHandling((request: Request) =>
  userController.updatePreferences(request),
);

export const dynamic = 'force-dynamic';
