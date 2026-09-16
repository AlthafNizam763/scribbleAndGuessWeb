import { TtlCache } from '@/utils/ttlCache';

/**
 * The shared world-leaderboard pages (brief section 10).
 *
 * ## Why this is its own module
 *
 * The cache is written by `leaderboard.service.ts` and invalidated by
 * `user.repository.ts`, and the service already imports the repository. Having
 * the repository import the service back would be a cycle — and a lazy
 * `import()` to dodge it does not survive the server build, where the path
 * alias in a dynamic import is not rewritten.
 *
 * A third module both can import statically has neither problem, and it makes
 * the ownership plain: the cache belongs to neither of them, it is a thing
 * they share.
 *
 * What may go in it, what may not, and why ten seconds is the right window is
 * documented on `LeaderboardService.worldSlice`, which is the only writer.
 */
export const worldLeaderboardCache = new TtlCache<[unknown[], number]>({
  ttlMs: 10_000,
  maxEntries: 200,
});

/**
 * Forgets the cached world board.
 *
 * Called when a match ends and scores move. The TTL would expire it within ten
 * seconds regardless, but a player who has just won and pulls to refresh
 * should see the standing they changed rather than the one from before their
 * game.
 */
export function forgetWorldLeaderboard(): void {
  worldLeaderboardCache.clear();
}
