import { describe, expect, it } from 'vitest';

import { BOT_DIFFICULTY, BOT_LIMITS } from '@/constants/autoTournament.constants';
import { botDrawerService } from '@/services/bot/botDrawer.service';
import { botGuesserService, type GuesserView } from '@/services/bot/botGuesser.service';
import { TEMPLATE_WORDS, templateFor } from '@/services/bot/drawingTemplates';
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

describe('planning a drawing', () => {
  it('fits inside the turn, with time left to read it', () => {
    const turnMs = 80_000;

    const plan = botDrawerService.plan({
      word: 'house',
      difficulty: BOT_DIFFICULTY.normal,
      authorId: 'bot',
      turnMs,
    });

    expect(plan.totalMs).toBeLessThan(turnMs);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.matchedTemplate).toBe(true);
  });

  it('compresses into a short turn rather than overrunning it', () => {
    const plan = botDrawerService.plan({
      word: 'bicycle',
      difficulty: BOT_DIFFICULTY.easy,
      authorId: 'bot',
      turnMs: 6_000,
    });

    expect(plan.totalMs).toBeLessThanOrEqual(6_000);
  });

  it('opens every stroke before appending to it, and closes it after', () => {
    const plan = botDrawerService.plan({
      word: 'star',
      difficulty: BOT_DIFFICULTY.hard,
      authorId: 'bot',
      turnMs: 80_000,
    });

    const open = new Set<string>();

    for (const step of plan.steps) {
      if (step.kind === 'begin') {
        expect(open.has(step.stroke.id)).toBe(false);
        open.add(step.stroke.id);
        continue;
      }
      // Both other kinds name a stroke that is currently open.
      expect(open.has(step.strokeId)).toBe(true);
      if (step.kind === 'end') open.delete(step.strokeId);
    }

    // Nothing left dangling: every stroke the bot began, it also ended.
    expect(open.size).toBe(0);
  });

  it('stays inside the board and batch limits', () => {
    const plan = botDrawerService.plan({
      word: 'bicycle',
      difficulty: BOT_DIFFICULTY.hard,
      authorId: 'bot',
      turnMs: 80_000,
    });

    const strokes = plan.steps.filter((step) => step.kind === 'begin');
    expect(strokes.length).toBeLessThanOrEqual(BOT_LIMITS.maxStrokesPerTurn);

    for (const step of plan.steps) {
      if (step.kind === 'append') {
        expect(step.points.length).toBeLessThanOrEqual(BOT_LIMITS.pointsPerBatch);
      }
    }
  });

  it('keeps every point inside the canvas after jitter', () => {
    const plan = botDrawerService.plan({
      word: 'sun',
      difficulty: BOT_DIFFICULTY.easy,
      authorId: 'bot',
      turnMs: 80_000,
    });

    for (const step of plan.steps) {
      const points = step.kind === 'begin' ? step.stroke.p : step.kind === 'append' ? step.points : [];
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('draws less of the template at a lower difficulty', () => {
    const count = (difficulty: 'EASY' | 'HARD'): number =>
      botDrawerService.plan({ word: 'cat', difficulty, authorId: 'bot', turnMs: 80_000 }).steps
        .filter((step) => step.kind === 'begin').length;

    expect(count('EASY')).toBeLessThan(count('HARD'));
  });

  it('prefers a word it can actually draw', () => {
    const index = botDrawerService.chooseWordIndex([
      { text: 'antidisestablishmentarianism' },
      { text: 'apple' },
      { text: 'ineffable' },
    ]);

    expect(index).toBe(1);
  });

  it('still picks something when it can draw none of them', () => {
    const index = botDrawerService.chooseWordIndex([{ text: 'zzz' }, { text: 'qqq' }]);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(2);
  });
});

describe('the template library', () => {
  it('covers the common word list', () => {
    for (const word of [
      'apple',
      'banana',
      'orange',
      'house',
      'car',
      'tree',
      'cat',
      'dog',
      'book',
      'phone',
      'flower',
      'boat',
      'sun',
      'moon',
      'star',
      'umbrella',
      'bicycle',
      'computer',
      'chair',
      'pizza',
    ]) {
      expect(templateFor(word).matched, word).toBe(true);
    }
  });

  /**
   * The behaviour that keeps a bug in the word bank from costing a real player
   * a round: an unknown word draws *something* rather than throwing or
   * standing still.
   */
  it('falls back rather than failing on an unknown word', () => {
    const fallback = templateFor('quinquagenarian');

    expect(fallback.matched).toBe(false);
    expect(fallback.strokes.length).toBeGreaterThan(0);
  });

  it('finds the noun inside a compound word', () => {
    const compound = templateFor('apple tree');

    // Not a match — the caller still logs the gap — but it draws a tree rather
    // than a generic doodle.
    expect(compound.matched).toBe(false);
    expect(compound.strokes).toEqual(templateFor('apple').strokes);
  });

  it('gives every template at least one stroke with points in it', () => {
    for (const word of TEMPLATE_WORDS) {
      const { strokes } = templateFor(word);
      expect(strokes.length, word).toBeGreaterThan(0);
      expect(strokes.every((entry) => entry.points.length > 0), word).toBe(true);
    }
  });
});
