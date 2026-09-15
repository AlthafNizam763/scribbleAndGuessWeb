import { leaderboardController } from '@/controllers/leaderboard.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/leaderboard/me/rank?scope=world|friends|locality`
 *
 * The caller's standing in one scope, without a page of rows — so a client can
 * pin "you are 4,212nd" above a board the player is nowhere near.
 */
export const GET = withErrorHandling((request: Request) => leaderboardController.myRank(request));

export const dynamic = 'force-dynamic';
