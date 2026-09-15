import { userController } from '@/controllers/user.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `PATCH /api/users/me/locality` — set the town this player plays from.
 *
 * A city, a region and a two-letter country code. There is no field here or on
 * the user document for a street, a postcode or a coordinate, so no request
 * can store one.
 */
export const PATCH = withErrorHandling((request: Request) =>
  userController.updateLocality(request),
);

export const dynamic = 'force-dynamic';
