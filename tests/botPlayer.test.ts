import { describe, expect, it } from 'vitest';

import { BOT_DIFFICULTY } from '@/constants/autoTournament.constants';
import { botGuesserService, type GuesserView } from '@/services/bot/botGuesser.service';
import { maskWord } from '@/services/hint.service';
import type { StrokeDto } from '@/types/drawing.types';

/**
 * The AI players.
 *
 * ## What is worth asserting, and what is not
 *
 * Not "does the bot win". A bot that wins reliably is a bug and a bot that
 * never does is furniture, so the interesting properties are the ones either
 * of those would violate:
 *
 * - The guesser cannot reach the answer. Not "does not" — *cannot*, which is
 *   a property of its interface and is checked by constructing the only input
 *   it accepts and observing that the word is not in it.
 * - A drawing finishes inside the turn and stays within the board's limits.
 * - A difficulty actually changes something.
 */

const now = Date.now();

/** A guesser's view of a turn, built the way the engine builds one. */
function viewOf(input: {
  word: string;
  revealed?: number[];
  strokes?: StrokeDto[];
  progress?: number;
}): GuesserView {
  const revealed = input.revealed ?? [];

  return {
    // Exactly what `serializeGameState` puts in a guesser's payload.
    maskedWord: maskWord(input.word, revealed),
    wordLength: input.word.replace(/[^\p{L}\p{N}]/gu, '').length,
    hintIndices: revealed,
    strokes: input.strokes ?? [],
    progress: input.progress ?? 0.5,
  };
}

/** A stroke, in the shape the board holds. */
function stroke(overrides: Partial<StrokeDto> = {}): StrokeDto {
  return {
    id: Math.random().toString(36).slice(2),
    a: 'bot',
    p: [
      [0.4, 0.4],
      [0.6, 0.6],
    ],
    c: 0xff222222,
    w: 4,
    t: 'pen',
    ts: now,
    ...overrides,
  };
}

const POOL = [
  { text: 'apple' },
  { text: 'house' },
  { text: 'guitar' },
  { text: 'banana' },
  { text: 'computer' },
  { text: 'star' },
  { text: 'moon' },
];

describe('what a bot guesser is allowed to know', () => {
  /**
   * The guarantee, stated as a test.
   *
   * `GuesserView` is the only input `nextGuess` takes, and it is built from
   * the masked word, the length, the revealed positions and the board. There
   * is no field on it that carries the answer, so there is nothing for an
   * implementation to accidentally read — which is why this asserts on the
   * *shape* rather than on behaviour.
   */
  it('receives no field that could carry the answer', () => {
    const view = viewOf({ word: 'guitar' });

    expect(Object.keys(view).sort()).toEqual([
      'hintIndices',
      'maskedWord',
      'progress',
      'strokes',
      'wordLength',
    ]);
    expect(JSON.stringify(view)).not.toContain('guitar');
  });

  it('only ever names a word from the pool it was handed', () => {
    for (let i = 0; i < 40; i++) {
      const guess = botGuesserService.nextGuess({
        view: viewOf({ word: 'guitar', strokes: [stroke(), stroke(), stroke()] }),
        pool: POOL,
        tried: new Set(),
        difficulty: BOT_DIFFICULTY.hard,
      });

      if (guess !== null) {
        expect(POOL.map((entry) => entry.text)).toContain(guess);
      }
    }
  });
});

describe('reading the blanks', () => {
  it('never guesses a word of the wrong length', () => {
    // `house` is five letters; only `apple` matches in this pool.
    for (let i = 0; i < 30; i++) {
      const guess = botGuesserService.nextGuess({
        view: viewOf({ word: 'house' }),
        // `house` itself withheld, so a wrong-length answer would be visible.
        pool: [{ text: 'apple' }, { text: 'banana' }, { text: 'computer' }],
        tried: new Set(),
        difficulty: BOT_DIFFICULTY.normal,
      });

      expect(guess === null || guess === 'apple').toBe(true);
    }
  });

  it('honours a revealed letter', () => {
    // `_ _ o _` rules out `star` and leaves `moon`.
    const guess = botGuesserService.nextGuess({
      view: viewOf({ word: 'moon', revealed: [2] }),
      pool: [{ text: 'star' }, { text: 'moon' }],
      tried: new Set(),
      difficulty: BOT_DIFFICULTY.normal,
    });

    expect(guess).toBe('moon');
  });

  it('never repeats a word it has already tried', () => {
    const guess = botGuesserService.nextGuess({
      view: viewOf({ word: 'moon', revealed: [2] }),
      pool: [{ text: 'star' }, { text: 'moon' }],
      tried: new Set(['moon']),
      difficulty: BOT_DIFFICULTY.normal,
    });

    // `star` fails the mask, `moon` is spent: the honest answer is silence.
    expect(guess).toBeNull();
  });

  it('says nothing rather than guessing when the pool is exhausted', () => {
    expect(
      botGuesserService.nextGuess({
        view: viewOf({ word: 'guitar' }),
        pool: [],
        tried: new Set(),
        difficulty: BOT_DIFFICULTY.hard,
      }),
    ).toBeNull();
  });

  /**
   * In `hidden` mode the server withholds the length until the first hint, and
   * the view says so with a zero. The bot has to cope rather than filtering
   * every candidate out.
   */
  it('still guesses when the length is withheld', () => {
    const view = { ...viewOf({ word: 'guitar' }), wordLength: 0, maskedWord: '' };

    const guess = botGuesserService.nextGuess({
      view,
      pool: POOL,
      tried: new Set(),
      difficulty: BOT_DIFFICULTY.easy,
    });

    expect(guess).not.toBeNull();
  });
});

describe('difficulty', () => {
  it('makes a harder bot guess sooner', () => {
    const easy = botGuesserService.nextDelayMs(BOT_DIFFICULTY.easy);
    const hard = botGuesserService.nextDelayMs(BOT_DIFFICULTY.hard);

    expect(easy).toBeGreaterThanOrEqual(8_000);
    expect(easy).toBeLessThanOrEqual(15_000);
    expect(hard).toBeGreaterThanOrEqual(2_000);
    expect(hard).toBeLessThanOrEqual(6_000);
  });

  /**
   * Two bots on fixed delays would guess in lockstep every turn. The range is
   * re-rolled per attempt so they interleave.
   */
  it('varies the delay between attempts', () => {
    const samples = new Set(
      Array.from({ length: 30 }, () => botGuesserService.nextDelayMs(BOT_DIFFICULTY.normal)),
    );

    expect(samples.size).toBeGreaterThan(1);
  });
});
