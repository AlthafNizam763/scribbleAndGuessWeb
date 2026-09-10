import { describe, expect, it } from 'vitest';

import { hintSchedule, letterCount, maskWord, nextHintIndices } from '@/services/hint.service';
import { TIMING } from '@/constants/game.constants';

/**
 * The hint engine (brief sections 34 and 65).
 *
 * The properties that matter: a hint never reveals more than half the word,
 * spaces and hyphens are free, and revealing is cumulative so a repeated or
 * retried tick cannot give away extra letters.
 */

describe('maskWord', () => {
  it('renders every letter as a spaced blank when nothing is revealed', () => {
    expect(maskWord('cat', [])).toBe('_ _ _');
  });

  it('fills in revealed positions', () => {
    // The brief's own example: ELEPHANT with the third letter shown.
    expect(maskWord('elephant', [2])).toBe('_ _ e _ _ _ _ _');
  });

  it('always shows spaces and hyphens', () => {
    expect(maskWord('ice cream', [])).toBe('_ _ _   _ _ _ _ _');
    expect(maskWord('t-shirt', [])).toBe('_ - _ _ _ _ _');
  });

  it('ignores positions outside the word', () => {
    expect(maskWord('cat', [99])).toBe('_ _ _');
  });
});

describe('letterCount', () => {
  it('counts only maskable characters', () => {
    expect(letterCount('cat')).toBe(3);
    // The space is free, so it is not part of the length players see.
    expect(letterCount('ice cream')).toBe(8);
    expect(letterCount('t-shirt')).toBe(6);
  });
});

describe('nextHintIndices', () => {
  it('reveals one position per hint', () => {
    const first = nextHintIndices({
      word: 'elephant',
      current: [],
      totalHints: 3,
      hintNumber: 1,
    });
    expect(first).toHaveLength(1);

    const second = nextHintIndices({
      word: 'elephant',
      current: first,
      totalHints: 3,
      hintNumber: 2,
    });
    expect(second).toHaveLength(2);
    // Cumulative: the first hint stays revealed.
    expect(second).toEqual(expect.arrayContaining(first));
  });

  it('is idempotent for the same hint number', () => {
    // A duplicated or retried timer tick must not reveal an extra letter.
    const once = nextHintIndices({ word: 'elephant', current: [], totalHints: 3, hintNumber: 1 });
    const twice = nextHintIndices({
      word: 'elephant',
      current: once,
      totalHints: 3,
      hintNumber: 1,
    });

    expect(twice).toEqual(once);
  });

  it('never reveals more than half the letters', () => {
    const revealed = nextHintIndices({
      word: 'cat',
      current: [],
      totalHints: 99,
      hintNumber: 99,
    });

    // Three letters: at most one may ever be shown.
    expect(revealed.length).toBeLessThanOrEqual(1);
  });

  it('respects the configured hint count', () => {
    const revealed = nextHintIndices({
      word: 'elephant',
      current: [],
      totalHints: 2,
      hintNumber: 5,
    });

    expect(revealed).toHaveLength(2);
  });

  it('reveals nothing when hints are switched off', () => {
    expect(
      nextHintIndices({ word: 'elephant', current: [], totalHints: 0, hintNumber: 1 }),
    ).toEqual([]);
  });

  it('never reveals a space or a hyphen', () => {
    const word = 'ice cream';
    const revealed = nextHintIndices({ word, current: [], totalHints: 4, hintNumber: 4 });

    for (const index of revealed) {
      expect(word[index]).not.toBe(' ');
      expect(word[index]).not.toBe('-');
    }
  });

  it('drops stale positions from a previous word', () => {
    const revealed = nextHintIndices({
      word: 'cat',
      current: [40, 41],
      totalHints: 1,
      hintNumber: 1,
    });

    expect(revealed.every((index) => index < 3)).toBe(true);
  });

  it('returns sorted positions', () => {
    const revealed = nextHintIndices({
      word: 'elephant',
      current: [],
      totalHints: 4,
      hintNumber: 4,
    });

    expect(revealed).toEqual([...revealed].sort((a, b) => a - b));
  });

  it('spreads hints apart rather than clumping them', () => {
    // Two adjacent letters tell a guesser far less than two spread out.
    const revealed = nextHintIndices({
      word: 'refrigerator',
      current: [],
      totalHints: 2,
      hintNumber: 2,
    });

    expect(revealed).toHaveLength(2);
    expect(Math.abs((revealed[1] ?? 0) - (revealed[0] ?? 0))).toBeGreaterThan(1);
  });
});

describe('hintSchedule', () => {
  const start = 1_000_000;
  const end = start + 60_000;

  it('books one timer per hint', () => {
    const schedule = hintSchedule({
      turnStartMs: start,
      turnEndMs: end,
      hintCount: 3,
      firstAtFraction: TIMING.firstHintAtFraction,
      lastAtFraction: TIMING.lastHintAtFraction,
    });

    expect(schedule).toHaveLength(3);
  });

  it('reveals nothing in the opening seconds', () => {
    const [first] = hintSchedule({
      turnStartMs: start,
      turnEndMs: end,
      hintCount: 2,
      firstAtFraction: TIMING.firstHintAtFraction,
      lastAtFraction: TIMING.lastHintAtFraction,
    });

    // Guessing early is worth the most; a hint then would undercut it.
    expect(first).toBeGreaterThan(start + 20_000);
  });

  it('finishes before the buzzer', () => {
    const schedule = hintSchedule({
      turnStartMs: start,
      turnEndMs: end,
      hintCount: 4,
      firstAtFraction: TIMING.firstHintAtFraction,
      lastAtFraction: TIMING.lastHintAtFraction,
    });

    expect(schedule[schedule.length - 1]).toBeLessThan(end);
  });

  it('is empty when hints are off or the turn has no length', () => {
    const args = {
      turnStartMs: start,
      firstAtFraction: 0.45,
      lastAtFraction: 0.85,
    };

    expect(hintSchedule({ ...args, turnEndMs: end, hintCount: 0 })).toEqual([]);
    expect(hintSchedule({ ...args, turnEndMs: start, hintCount: 3 })).toEqual([]);
  });

  it('places a single hint at the first fraction', () => {
    const [only] = hintSchedule({
      turnStartMs: start,
      turnEndMs: end,
      hintCount: 1,
      firstAtFraction: 0.5,
      lastAtFraction: 0.85,
    });

    expect(only).toBe(start + 30_000);
  });
});
