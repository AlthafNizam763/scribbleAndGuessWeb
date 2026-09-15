import { leaderboardController } from '@/controllers/leaderboard.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/leaderboard/locality?page=&limit=` — players from the caller's town.
 *
 * Grouped by a normalised country/region/city key held on the user row. A
 * caller who has not set a city gets an empty page with `locality: null`,
 * which the client renders as a prompt to finish their profile.
 */
export const GET = withErrorHandling((request: Request) => leaderboardController.locality(request));

export const dynamic = 'force-dynamic';
