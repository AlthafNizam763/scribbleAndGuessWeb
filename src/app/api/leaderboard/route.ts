import { leaderboardController } from '@/controllers/leaderboard.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/leaderboard` — public, paginated, with the caller's own rank. */
export const GET = withErrorHandling((request: Request) => leaderboardController.top(request));

export const dynamic = 'force-dynamic';
