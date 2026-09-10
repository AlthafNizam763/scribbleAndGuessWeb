import { userRepository } from '@/repositories/user.repository';

/**
 * The global leaderboard.
 *
 * Ranked by lifetime score, which is simply the sum of every point a player
 * has ever earned. Ties break by wins and then by id, so the order is stable
 * between requests — a leaderboard that reshuffles equal scores on refresh
 * looks broken even though nothing changed.
 *
 * Players who have never finished a game are excluded rather than shown on
 * zero: a table whose tail is thousands of empty guest accounts is not a
 * leaderboard.
 */

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  avatarId: number;
  avatarColorIndex: number;
  totalScore: number;
  gamesPlayed: number;
  wins: number;
  bestRoundScore: number;
  updatedAtMs: number;
  rank: number;
}

export class LeaderboardService {
  async top(input: { limit: number; page: number }): Promise<{
    entries: LeaderboardEntry[];
    total: number;
    page: number;
    limit: number;
  }> {
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const page = Math.max(input.page, 1);
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      userRepository.leaderboard(limit, skip),
      userRepository.countRanked(),
    ]);

    const entries = rows.map<LeaderboardEntry>((row, index) => ({
      playerId: String(row._id),
      name: row.username,
      avatarId: row.avatarId,
      avatarColorIndex: row.avatarColorIndex,
      totalScore: row.totalScore,
      gamesPlayed: row.gamesPlayed,
      wins: row.gamesWon,
      bestRoundScore: row.bestRoundScore,
      updatedAtMs: new Date(row.updatedAt ?? Date.now()).getTime(),
      rank: skip + index + 1,
    }));

    return { entries, total, page, limit };
  }
}

export const leaderboardService = new LeaderboardService();
