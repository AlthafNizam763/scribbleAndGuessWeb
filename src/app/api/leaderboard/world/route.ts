import { leaderboardController } from '@/controllers/leaderboard.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/leaderboard/world?page=&limit=` — every eligible player, ranked.
 *
 * Authentication is optional. Without a token the page is the public board;
 * with one it also carries the caller's own rank and row, which is the number
 * they came for and would otherwise cost a second request.
 */
export const GET = withErrorHandling((request: Request) => leaderboardController.world(request));

export const dynamic = 'force-dynamic';
