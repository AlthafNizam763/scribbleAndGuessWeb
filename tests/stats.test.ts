import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACHIEVEMENTS } from '@/constants/progression.constants';
import { GAME_MODE } from '@/constants/gameModes.constants';
import { progressionRepository } from '@/repositories/progression.repository';
import { userRepository } from '@/repositories/user.repository';
import { defaultSettings } from '@/services/room.service';
import { statsService } from '@/services/stats.service';
import { wordService } from '@/services/word.service';
import { ErrorCode } from '@/utils/errors';

/**
 * Player statistics, and the word pool's difficulty filter.
 *
 * ## The difficulty filter is here because it was broken
 *
 * Batch B added a `wordDifficulty` setting and gave Challenge mode an override
 * for it — but nothing read the field, so Challenge played exactly like
 * Classic. The mode's own tests passed, because they asserted the *setting*
 * resolved correctly rather than that any word pool narrowed. These are the
 * tests that would have caught it.
 *
 * ## Statistics are derived, never stored
 *
 * So the risk is not a stale figure but a bad ratio: a division by zero on a
 * fresh account, or a rate that exceeds 100% because its two counters were
 * written out of step. Both are pinned below.
 */

const USER = '507f1f77bcf86cd799439011';

/** A user row as `.lean()` hands one back. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: USER,
    username: 'Ana',
    gamesPlayed: 10,
    gamesWon: 4,
    totalScore: 2500,
    bestRoundScore: 480,
    correctGuesses: 120,
    firstGuesses: 30,
    fastGuesses: 8,
    drawingTurns: 20,
    perfectDrawings: 5,
    currentWinStreak: 2,
    bestWinStreak: 6,
    xp: 1200,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  wordService.clearCache();
});

describe('player statistics', () => {
  it('derives losses, rates and averages from the counters', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue(userRow() as never);
    vi.spyOn(progressionRepository, 'listUnlocked').mockResolvedValue([
      { key: 'first_game' },
      { key: 'first_win' },
    ] as never);

    const stats = await statsService.forUser(USER);

    expect(stats.gamesLost).toBe(6);
    expect(stats.winRate).toBe(40);
    expect(stats.averageScore).toBe(250);
    expect(stats.perfectDrawingRate).toBe(25);
    expect(stats.achievementsUnlocked).toBe(2);
    expect(stats.achievementsTotal).toBe(ACHIEVEMENTS.length);
  });

  /** A fresh account divides by zero in four places if nothing guards it. */
  it('reports zeroes for an account that has never played', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue(
      userRow({
        gamesPlayed: 0,
        gamesWon: 0,
        totalScore: 0,
        drawingTurns: 0,
        perfectDrawings: 0,
        xp: 0,
      }) as never,
    );
    vi.spyOn(progressionRepository, 'listUnlocked').mockResolvedValue([] as never);

    const stats = await statsService.forUser(USER);

    expect(stats.winRate).toBe(0);
    expect(stats.averageScore).toBe(0);
    expect(stats.perfectDrawingRate).toBe(0);
    expect(stats.gamesLost).toBe(0);
    expect(stats.level).toBe(1);
  });

  /**
   * Counters are written by separate `$inc`s, so a crash between two of them
   * could leave wins above games. The derived figure must not go negative.
   */
  it('never reports negative losses when counters disagree', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue(
      userRow({ gamesPlayed: 3, gamesWon: 5 }) as never,
    );
    vi.spyOn(progressionRepository, 'listUnlocked').mockResolvedValue([] as never);

    expect((await statsService.forUser(USER)).gamesLost).toBe(0);
  });

  it('survives an achievement read that failed', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue(userRow() as never);
    vi.spyOn(progressionRepository, 'listUnlocked').mockRejectedValue(new Error('down'));

    const stats = await statsService.forUser(USER);

    // The career record is worth showing even when the trophy count is not
    // available, so the failure costs one number rather than the screen.
    expect(stats.achievementsUnlocked).toBe(0);
    expect(stats.gamesPlayed).toBe(10);
  });

  it('refuses an account that does not exist', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue(null);
    // Both reads are issued in parallel, so this one has to be stubbed too —
    // otherwise it reaches for a database the suite deliberately does not have.
    vi.spyOn(progressionRepository, 'listUnlocked').mockResolvedValue([] as never);

    const error = await statsService.forUser(USER).catch((thrown: unknown) => thrown);
    expect((error as { code: string }).code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('the word pool difficulty filter', () => {
  const POOL = [
    { text: 'cat', category: 'animals', difficulty: 'easy', aliases: [] },
    { text: 'house', category: 'objects', difficulty: 'easy', aliases: [] },
    { text: 'tree', category: 'nature', difficulty: 'easy', aliases: [] },
    { text: 'guitar', category: 'music', difficulty: 'medium', aliases: [] },
    { text: 'rocket', category: 'vehicles', difficulty: 'medium', aliases: [] },
    { text: 'lighthouse', category: 'places', difficulty: 'hard', aliases: [] },
    { text: 'telescope', category: 'technology', difficulty: 'hard', aliases: [] },
    { text: 'chandelier', category: 'objects', difficulty: 'hard', aliases: [] },
  ];

  function withPool() {
    vi.spyOn(wordService, 'pool').mockResolvedValue(POOL as never);
  }

  /** The bug: Challenge mode must actually narrow the pool. */
  it('offers only hard words when the difficulty is hard', async () => {
    withPool();

    const choices = await wordService.pickChoices({
      settings: { ...defaultSettings(), wordDifficulty: 'hard' },
      usedWords: new Set(),
      count: 3,
    });

    expect(choices).toHaveLength(3);
    for (const choice of choices) expect(choice.difficulty).toBe('hard');
  });

  it('offers the whole pool when no difficulty is set', async () => {
    withPool();

    const choices = await wordService.pickChoices({
      settings: { ...defaultSettings(), wordDifficulty: null },
      usedWords: new Set(),
      count: 8,
    });

    expect(choices).toHaveLength(8);
  });

  /**
   * A word bank thin in one difficulty should degrade into mixed difficulty
   * rather than into a turn with two choices where three were asked for.
   */
  it('relaxes the filter rather than offering fewer choices', async () => {
    vi.spyOn(wordService, 'pool').mockResolvedValue([
      { text: 'cat', category: 'animals', difficulty: 'easy', aliases: [] },
      { text: 'house', category: 'objects', difficulty: 'easy', aliases: [] },
      { text: 'lighthouse', category: 'places', difficulty: 'hard', aliases: [] },
    ] as never);

    const choices = await wordService.pickChoices({
      settings: { ...defaultSettings(), wordDifficulty: 'hard' },
      usedWords: new Set(),
      count: 3,
    });

    expect(choices).toHaveLength(3);
  });

  /**
   * Freshness and difficulty are relaxed independently: running out of hard
   * words should fall back to the whole pool, not to hard words already drawn.
   */
  it('prefers unplayed words within the chosen difficulty', async () => {
    withPool();

    const choices = await wordService.pickChoices({
      settings: { ...defaultSettings(), wordDifficulty: 'hard' },
      usedWords: new Set(['lighthouse']),
      count: 2,
    });

    expect(choices.map((choice) => choice.text).sort()).toEqual([
      'chandelier',
      'telescope',
    ]);
  });

  it('drops profanity from a host custom word list', async () => {
    withPool();

    const choices = await wordService.pickChoices({
      settings: {
        ...defaultSettings(),
        customWords: ['sunset', 'bitch', 'harbour', 'kettle', 'anchor'],
      },
      usedWords: new Set(),
      count: 5,
    });

    const words = choices.map((choice) => choice.text);
    expect(words).not.toContain('bitch');
    expect(words).toHaveLength(4);
  });

  /** Challenge's override is only useful if the pool honours it end to end. */
  it('narrows the pool for a Challenge room', async () => {
    withPool();

    const { gameModeService } = await import('@/services/gameMode.service');
    const settings = gameModeService.resolveSettings({
      ...defaultSettings(),
      gameMode: GAME_MODE.challenge,
    });

    const choices = await wordService.pickChoices({
      settings,
      usedWords: new Set(),
      count: 3,
    });

    for (const choice of choices) expect(choice.difficulty).toBe('hard');
  });
});
