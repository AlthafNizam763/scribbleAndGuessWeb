import { describe, expect, it } from 'vitest';

import { TOURNAMENT_STATUS } from '@/constants/tournament.constants';
import { tournamentService } from '@/services/tournament.service';

/**
 * Tournaments.
 *
 * ## Why the status derivation carries the tests
 *
 * There is no stored status column and no scheduled job that advances one —
 * three timestamps and the clock decide everything. That is the design's whole
 * advantage and its whole risk: an off-by-one in `statusOf` would open
 * registration early, close a tournament late, or let a match count towards an
 * event that had already finished. None of those would throw; they would just
 * be quietly wrong.
 *
 * The scoring path is not tested here because there is nothing client-supplied
 * in it to test: the engine passes the score it already computed, and there is
 * no endpoint that writes one. What *is* worth pinning is that a match only
 * counts while the window is genuinely open.
 */

const HOUR = 60 * 60 * 1000;
const NOW = 1700000000000;

/** A tournament whose three timestamps are set relative to [NOW]. */
function windowOf(registerH: number, startH: number, endH: number) {
  return {
    registerFrom: new Date(NOW + registerH * HOUR),
    startsAt: new Date(NOW + startH * HOUR),
    endsAt: new Date(NOW + endH * HOUR),
  };
}

describe('deriving a tournament status', () => {
  it('is announced before registration opens', () => {
    expect(tournamentService.statusOf(windowOf(1, 2, 4), NOW)).toBe(
      TOURNAMENT_STATUS.announced,
    );
  });

  it('is registering between opening and start', () => {
    expect(tournamentService.statusOf(windowOf(-1, 2, 4), NOW)).toBe(
      TOURNAMENT_STATUS.registering,
    );
  });

  it('is live between start and end', () => {
    expect(tournamentService.statusOf(windowOf(-4, -1, 2), NOW)).toBe(
      TOURNAMENT_STATUS.live,
    );
  });

  it('is finished after the end', () => {
    expect(tournamentService.statusOf(windowOf(-8, -6, -1), NOW)).toBe(
      TOURNAMENT_STATUS.finished,
    );
  });

  /**
   * The boundaries, which is where an off-by-one would live. A tournament is
   * live *at* its start instant and finished *at* its end instant — inclusive
   * at the start, exclusive at the end, so the two states never overlap.
   */
  it('flips exactly on the start instant', () => {
    const window = windowOf(-2, 0, 2);

    expect(tournamentService.statusOf(window, NOW - 1)).toBe(
      TOURNAMENT_STATUS.registering,
    );
    expect(tournamentService.statusOf(window, NOW)).toBe(TOURNAMENT_STATUS.live);
  });

  it('flips exactly on the end instant', () => {
    const window = windowOf(-4, -2, 0);

    expect(tournamentService.statusOf(window, NOW - 1)).toBe(TOURNAMENT_STATUS.live);
    expect(tournamentService.statusOf(window, NOW)).toBe(
      TOURNAMENT_STATUS.finished,
    );
  });

  /**
   * A badly configured row — end before start — must not read as live. The
   * checks run finished-first precisely so this collapses to "over" rather
   * than to a tournament that never closes.
   */
  it('reads a misconfigured window as finished rather than live', () => {
    const broken = {
      registerFrom: new Date(NOW - 4 * HOUR),
      startsAt: new Date(NOW + 2 * HOUR),
      endsAt: new Date(NOW - 1 * HOUR),
    };

    expect(tournamentService.statusOf(broken, NOW)).toBe(
      TOURNAMENT_STATUS.finished,
    );
  });
});

describe('whether a match counts', () => {
  it('counts only while the window is open', () => {
    expect(tournamentService.isLive(windowOf(-4, -1, 2), NOW)).toBe(true);
    expect(tournamentService.isLive(windowOf(-1, 2, 4), NOW)).toBe(false);
    expect(tournamentService.isLive(windowOf(-8, -6, -1), NOW)).toBe(false);
  });

  /**
   * A room open since before the tournament ended does not keep counting: what
   * matters is when the match *finished*, which is when the engine calls in.
   */
  it('stops counting the moment the window closes', () => {
    const window = windowOf(-4, -2, 0);

    expect(tournamentService.isLive(window, NOW - 1000)).toBe(true);
    expect(tournamentService.isLive(window, NOW + 1000)).toBe(false);
  });
});
