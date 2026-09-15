import { leaderboardController } from '@/controllers/leaderboard.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/leaderboard/friends?page=&limit=` — the caller and their friends.
 *
 * Requires a token, because "your friends" has no anonymous answer. The caller
 * is always in the list, even on zero games.
 */
export const GET = withErrorHandling((request: Request) => leaderboardController.friends(request));

export const dynamic = 'force-dynamic';
