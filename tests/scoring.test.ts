import { describe, expect, it } from 'vitest';

import { ScoringService, defaultScoringConfig } from '@/services/scoring.service';

/**
 * Scoring (brief section 65).
 *
 * These assert the *properties* that make the formula fair rather than pinning
 * exact numbers: a test that hard-codes 210 would fail the moment somebody
 * tuned a weight, which is exactly the change the brief asks to keep possible.
 * The couple of exact assertions that remain are the boundaries — a guess at
 * t=0 and one at the buzzer — because those are contractual.
 */

const scoring = new ScoringService();

describe('guesser points', () => {
  it('awards the maximum plus the first-guess bonus for an instant guess', () => {
    const points = scoring.guesserPoints({
      msRemaining: 60_000,
      msTotal: 60_000,
      guessOrder: 1,
      difficulty: 'easy',
    });

    // max (100) + first bonus (25), times the easy multiplier of 1.0.
    expect(points).toBe(125);
  });

  it('still awards the floor for a guess as the buzzer sounds', () => {
    const points = scoring.guesserPoints({
      msRemaining: 0,
      msTotal: 60_000,
      guessOrder: 4,
      difficulty: 'easy',
    });

    // A late guess must never be worthless, or players stop trying.
    expect(points).toBe(defaultScoringConfig.minGuessPoints);
    expect(points).toBeGreaterThan(0);
  });

  it('rewards guessing sooner', () => {
    const early = scoring.guesserPoints({
      msRemaining: 50_000,
      msTotal: 60_000,
      guessOrder: 2,
      difficulty: 'medium',
    });
    const late = scoring.guesserPoints({
      msRemaining: 10_000,
      msTotal: 60_000,
      guessOrder: 2,
      difficulty: 'medium',
    });

    expect(early).toBeGreaterThan(late);
  });

  it('rewards guessing first, all else being equal', () => {
    const base = { msRemaining: 30_000, msTotal: 60_000, difficulty: 'easy' } as const;

    const first = scoring.guesserPoints({ ...base, guessOrder: 1 });
    const second = scoring.guesserPoints({ ...base, guessOrder: 2 });
    const third = scoring.guesserPoints({ ...base, guessOrder: 3 });
    const fourth = scoring.guesserPoints({ ...base, guessOrder: 4 });

    expect(first).toBeGreaterThan(second);
    expect(second).toBeGreaterThan(third);
    expect(third).toBeGreaterThan(fourth);
    // Past third place there is no order bonus at all.
    expect(scoring.guesserPoints({ ...base, guessOrder: 9 })).toBe(fourth);
  });

  it('pays more for a harder word', () => {
    const base = { msRemaining: 30_000, msTotal: 60_000, guessOrder: 1 } as const;

    expect(scoring.guesserPoints({ ...base, difficulty: 'hard' })).toBeGreaterThan(
      scoring.guesserPoints({ ...base, difficulty: 'medium' }),
    );
    expect(scoring.guesserPoints({ ...base, difficulty: 'medium' })).toBeGreaterThan(
      scoring.guesserPoints({ ...base, difficulty: 'easy' }),
    );
  });

  it('does not pay more than the maximum for a round of zero length', () => {
    // A degenerate round should not divide by zero or award a bonus for it.
    const points = scoring.guesserPoints({
      msRemaining: 0,
      msTotal: 0,
      guessOrder: 1,
      difficulty: 'easy',
    });

    expect(points).toBe(defaultScoringConfig.minGuessPoints + defaultScoringConfig.firstGuessBonus);
  });

  it('never returns a negative score', () => {
    const points = scoring.guesserPoints({
      msRemaining: -5_000,
      msTotal: 60_000,
      guessOrder: 12,
      difficulty: 'easy',
    });

    expect(points).toBeGreaterThanOrEqual(0);
  });
});

describe('drawer points', () => {
  it('pays nothing when nobody guessed', () => {
    expect(
      scoring.drawerPoints({ correctGuessers: 0, totalGuessers: 4, difficulty: 'medium' }),
    ).toBe(0);
  });

  it('pays more as more players guess', () => {
    const one = scoring.drawerPoints({ correctGuessers: 1, totalGuessers: 4, difficulty: 'easy' });
    const two = scoring.drawerPoints({ correctGuessers: 2, totalGuessers: 4, difficulty: 'easy' });

    expect(two).toBeGreaterThan(one);
  });

  it('adds a bonus when the whole room gets it', () => {
    const partial = scoring.drawerPoints({
      correctGuessers: 3,
      totalGuessers: 4,
      difficulty: 'easy',
    });
    const everyone = scoring.drawerPoints({
      correctGuessers: 4,
      totalGuessers: 4,
      difficulty: 'easy',
    });

    // One more guesser is worth its own points plus the clean-sweep bonus.
    expect(everyone - partial).toBeGreaterThan(defaultScoringConfig.drawerPointsPerGuess);
  });

  it('caps the payout', () => {
    const points = scoring.drawerPoints({
      correctGuessers: 11,
      totalGuessers: 11,
      difficulty: 'hard',
    });

    expect(points).toBe(defaultScoringConfig.drawerMaxPoints);
  });

  it('ignores more correct guessers than there were players', () => {
    const points = scoring.drawerPoints({
      correctGuessers: 99,
      totalGuessers: 3,
      difficulty: 'easy',
    });

    expect(points).toBe(
      scoring.drawerPoints({ correctGuessers: 3, totalGuessers: 3, difficulty: 'easy' }),
    );
  });

  it('pays nothing in a room with no guessers', () => {
    expect(
      scoring.drawerPoints({ correctGuessers: 0, totalGuessers: 0, difficulty: 'easy' }),
    ).toBe(0);
  });
});

describe('standings', () => {
  it('ranks highest first', () => {
    const ranked = scoring.standings([
      { playerId: 'a', name: 'Ann', score: 100 },
      { playerId: 'b', name: 'Bob', score: 300 },
      { playerId: 'c', name: 'Cal', score: 200 },
    ]);

    expect(ranked.map((entry) => entry.playerId)).toEqual(['b', 'c', 'a']);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it('gives tied players the same rank and skips the next', () => {
    const ranked = scoring.standings([
      { playerId: 'a', name: 'Ann', score: 300 },
      { playerId: 'b', name: 'Bob', score: 300 },
      { playerId: 'c', name: 'Cal', score: 100 },
    ]);

    // Standard competition ranking: 1, 1, 3 — not 1, 2, 3.
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 1, 3]);
  });

  it('orders equal scores deterministically', () => {
    const players = [
      { playerId: 'z', name: 'Zoe', score: 50 },
      { playerId: 'a', name: 'Ann', score: 50 },
    ];

    // A leaderboard that reshuffles ties between broadcasts looks broken.
    expect(scoring.standings(players)).toEqual(scoring.standings(players));
    expect(scoring.standings(players)[0]?.name).toBe('Ann');
  });

  it('handles an empty room', () => {
    expect(scoring.standings([])).toEqual([]);
  });
});
