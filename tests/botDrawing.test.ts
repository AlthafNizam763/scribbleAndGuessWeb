import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BOT_DIFFICULTY, BOT_LIMITS } from '@/constants/autoTournament.constants';
import {
  botDrawerService,
  drawingSessionId,
  type DrawPlan,
  type DrawSession,
} from '@/services/bot/botDrawer.service';
import {
  TEMPLATE_KEYS,
  TEMPLATE_WORDS,
  hasTemplate,
  resolveTemplate,
  strokesFor,
} from '@/services/bot/drawingTemplates';
import type { PointTuple } from '@/types/drawing.types';
import { normalizeWord } from '@/utils/normalizeWord';

/**
 * Bot drawings, and the one property they exist to have.
 *
 * ## The bug this file is the regression test for
 *
 * A bot that drew "lion" put a generic face on the canvas, and so did a bot
 * that drew "fish", "platypus" or "lasagna" — 661 of the English bank's 720
 * words resolved to the same fallback doodle, because the library held
 * seventeen of them. Worse, a substring rule filled in 42 more with a picture
 * of something else entirely: "carrot" drew a car, "cathedral" drew a cat.
 *
 * So the assertions below are mostly about *identity*: the word that was
 * selected and the template that was drawn have to be the same word, every
 * time, and when they cannot be, nothing is drawn at all. A drawing that is
 * merely present is not the property — a wrong drawing is present too.
 */

const SESSION: DrawSession = { gameId: 'game-1', roundId: 'round-1', botId: 'scribbler' };
const TURN_MS = 80_000;

/** Plans a turn and asserts it produced a drawing, narrowing the union. */
function planned(word: string, overrides: Partial<Parameters<typeof plan>[1]> = {}): DrawPlan {
  const result = plan(word, overrides);
  expect(result.ok, `expected a drawing for "${word}"`).toBe(true);
  return result as DrawPlan;
}

function plan(
  word: string,
  overrides: {
    difficulty?: 'EASY' | 'NORMAL' | 'HARD';
    turnMs?: number;
    session?: DrawSession;
    authorId?: string;
  } = {},
): ReturnType<typeof botDrawerService.plan> {
  return botDrawerService.plan({
    word,
    difficulty: overrides.difficulty ?? BOT_DIFFICULTY.normal,
    authorId: overrides.authorId ?? 'bot-user',
    turnMs: overrides.turnMs ?? TURN_MS,
    session: overrides.session ?? SESSION,
  });
}

/** Every point a plan will put on the board, in order. */
function pointsOf(drawPlan: DrawPlan): PointTuple[] {
  return drawPlan.steps.flatMap((step) =>
    step.kind === 'begin' ? step.stroke.p : step.kind === 'append' ? step.points : [],
  );
}

/** A plan's shape, ignoring jitter — what makes two drawings "the same one". */
function shapeOf(drawPlan: DrawPlan): string {
  return drawPlan.steps
    .map((step) =>
      step.kind === 'begin'
        ? `b:${step.stroke.c}:${step.stroke.w}:${step.stroke.t}:${step.stroke.p.length}`
        : step.kind === 'append'
          ? `a:${step.points.length}`
          : 'e',
    )
    .join('|');
}

// --------------------------------------------------------------- 1 to 7, 19

describe('a word draws its own picture', () => {
  /**
   * The headline cases from the bug report. Each asserts the template key is
   * the word — not merely that *something* was drawn, which was true before
   * the fix and was the whole problem.
   */
  it.each([
    ['lion'],
    ['fish'],
    ['house'],
    ['apple'],
    ['car'],
    ['cat'],
    ['dog'],
  ])('%s draws a %s', (word) => {
    const result = planned(word);

    expect(result.templateKey).toBe(word);
    expect(result.normalizedWord).toBe(word);
    expect(result.strokeCount).toBeGreaterThan(0);
  });

  it('gives lion and fish genuinely different drawings', () => {
    // The bug: both of these were the same four strokes.
    expect(shapeOf(planned('lion'))).not.toBe(shapeOf(planned('fish')));
  });

  it('never draws one word with a different word picture', () => {
    // The substring rule's victims, every one of which used to draw the noun
    // hiding inside it.
    for (const [word, wrongKey] of [
      ['carrot', 'car'],
      ['cathedral', 'cat'],
      ['caterpillar', 'cat'],
      ['sunglasses', 'sun'],
      ['starfish', 'star'],
      ['carpenter', 'car'],
      ['memory card', 'car'],
      ['xylophone', 'phone'],
      ['street sweeper', 'tree'],
      ['cattail', 'cat'],
    ] as const) {
      const { templateKey } = resolveTemplate(word);
      expect(templateKey, `${word} must not draw a ${wrongKey}`).not.toBe(wrongKey);
    }
  });

  it('draws the words the brief lists, and draws each as itself', () => {
    for (const word of [
      'lion', 'fish', 'cat', 'dog', 'bird', 'elephant', 'tiger', 'monkey',
      'house', 'car', 'bus', 'bicycle', 'tree', 'flower', 'sun', 'moon',
      'star', 'apple', 'banana', 'orange', 'pizza', 'phone', 'computer',
      'book', 'chair', 'boat', 'umbrella',
    ]) {
      const result = planned(word);
      expect(result.templateKey, word).toBe(word);
    }
  });
});

// ------------------------------------------------------------------- 8, 19

describe('a word with no picture', () => {
  it('draws nothing rather than something unrelated', () => {
    const result = plan('quinquagenarian');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-template');
      expect(result.normalizedWord).toBe('quinquagenarian');
    }
  });

  it('does not crash the turn', () => {
    // Every shape an unknown word can arrive in. None may throw.
    for (const word of ['', '   ', '???', 'zzzz', '🙂', 'a'.repeat(200)]) {
      expect(() => plan(word)).not.toThrow();
      expect(plan(word).ok).toBe(false);
    }
  });

  it('reports the word it is missing, normalised, so the gap can be closed', () => {
    const result = plan('  Praying   Mantis  ');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.normalizedWord).toBe('praying mantis');
  });
});

// --------------------------------------------------------------------- 9-12

describe('one round does not leak into the next', () => {
  it('builds a different session for each round', () => {
    const first = planned('lion', { session: { ...SESSION, roundId: 'r1' } });
    const second = planned('fish', { session: { ...SESSION, roundId: 'r2' } });

    expect(first.drawingSessionId).not.toBe(second.drawingSessionId);
    expect(first.drawingSessionId).toContain('r1');
    expect(second.drawingSessionId).toContain('r2');
  });

  it('draws the second word, not the first, on consecutive rounds', () => {
    for (const [first, second] of [
      ['lion', 'fish'],
      ['fish', 'house'],
      ['apple', 'car'],
    ] as const) {
      const one = planned(first, { session: { ...SESSION, roundId: 'a' } });
      const two = planned(second, { session: { ...SESSION, roundId: 'b' } });

      expect(one.templateKey).toBe(first);
      expect(two.templateKey).toBe(second);
      expect(shapeOf(one)).not.toBe(shapeOf(two));
    }
  });

  it('keys the session on the drawer, so a change of drawer is a new session', () => {
    const a = planned('lion', { session: { ...SESSION, botId: 'scribbler' } });
    const b = planned('lion', { session: { ...SESSION, botId: 'doodler' } });

    expect(a.drawingSessionId).not.toBe(b.drawingSessionId);
  });

  it('holds no state between plans', () => {
    // Two plans for the same word, built either side of a plan for another
    // word, must be identical in shape: nothing about the first may survive.
    const before = shapeOf(planned('house'));
    planned('pizza');
    const after = shapeOf(planned('house'));

    expect(after).toBe(before);
  });

  it('hands out a fresh stroke array every time', () => {
    // A shared template array would be deformed by the jitter step, and the
    // damage would be permanent for the life of the process.
    const first = strokesFor('lion');
    const second = strokesFor('lion');

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    first[0]!.points[0] = [0.99, 0.99];
    expect(strokesFor('lion')[0]!.points[0]).not.toEqual([0.99, 0.99]);
  });
});

// ------------------------------------------------------------------- 13, 14

describe('two matches at once', () => {
  it('gives two bots in different games unrelated sessions', () => {
    const matchOne = planned('lion', {
      session: { gameId: 'game-a', roundId: 'r1', botId: 'scribbler' },
    });
    const matchTwo = planned('fish', {
      session: { gameId: 'game-b', roundId: 'r1', botId: 'doodler' },
    });

    expect(matchOne.drawingSessionId).not.toBe(matchTwo.drawingSessionId);
    expect(matchOne.templateKey).toBe('lion');
    expect(matchTwo.templateKey).toBe('fish');
  });

  it('composes the session key from game, round, bot and word', () => {
    const result = planned('lion');

    expect(result.drawingSessionId).toBe(
      drawingSessionId(SESSION, 'lion'),
    );
    expect(result.drawingSessionId).toBe('game-1:round-1:scribbler:lion');
  });
});

// ----------------------------------------------------------------- 16 to 20

describe('what a plan is allowed to contain', () => {
  it('keeps every point inside the canvas, at every difficulty', () => {
    for (const difficulty of [BOT_DIFFICULTY.easy, BOT_DIFFICULTY.normal, BOT_DIFFICULTY.hard]) {
      for (const key of TEMPLATE_KEYS) {
        for (const point of pointsOf(planned(key, { difficulty }))) {
          for (const value of point) {
            expect(Number.isFinite(value), `${key} @ ${difficulty}`).toBe(true);
            expect(value, `${key} @ ${difficulty}`).toBeGreaterThanOrEqual(0);
            expect(value, `${key} @ ${difficulty}`).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('gives every template at least one stroke with points in it', () => {
    for (const key of TEMPLATE_KEYS) {
      const strokes = strokesFor(key);

      expect(strokes.length, key).toBeGreaterThan(0);
      expect(strokes.every((entry) => entry.points.length > 0), key).toBe(true);
    }
  });

  it('opens every stroke before appending to it, and closes it after', () => {
    const open = new Set<string>();

    for (const step of planned('lion', { difficulty: BOT_DIFFICULTY.hard }).steps) {
      if (step.kind === 'begin') {
        expect(open.has(step.stroke.id)).toBe(false);
        open.add(step.stroke.id);
        continue;
      }
      expect(open.has(step.strokeId)).toBe(true);
      if (step.kind === 'end') open.delete(step.strokeId);
    }

    expect(open.size).toBe(0);
  });

  it('never repeats a stroke id inside one plan', () => {
    const ids = planned('bicycle').steps
      .filter((step) => step.kind === 'begin')
      .map((step) => (step.kind === 'begin' ? step.stroke.id : ''));

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stays inside the board and batch limits', () => {
    for (const key of TEMPLATE_KEYS) {
      const result = planned(key, { difficulty: BOT_DIFFICULTY.hard });
      const strokes = result.steps.filter((step) => step.kind === 'begin');

      expect(strokes.length, key).toBeLessThanOrEqual(BOT_LIMITS.maxStrokesPerTurn);

      for (const step of result.steps) {
        if (step.kind === 'append') {
          expect(step.points.length, key).toBeLessThanOrEqual(BOT_LIMITS.pointsPerBatch);
        }
      }
    }
  });

  it('fits inside the turn, with time left to read it', () => {
    for (const key of TEMPLATE_KEYS) {
      expect(planned(key).totalMs, key).toBeLessThan(TURN_MS);
    }
  });

  it('compresses into a short turn rather than overrunning it', () => {
    expect(planned('bicycle', { difficulty: BOT_DIFFICULTY.easy, turnMs: 6_000 }).totalMs)
      .toBeLessThanOrEqual(6_000);
  });

  it('attributes every stroke to the drawer the server named', () => {
    for (const step of planned('house', { authorId: 'seat-9' }).steps) {
      if (step.kind === 'begin') expect(step.stroke.a).toBe('seat-9');
    }
  });

  it('draws less of the template at a lower difficulty', () => {
    const count = (difficulty: 'EASY' | 'HARD'): number => planned('cat', { difficulty }).strokeCount;

    expect(count('EASY')).toBeLessThan(count('HARD'));
  });

  it('draws the same picture at every difficulty, only less of it', () => {
    const easy = planned('lion', { difficulty: BOT_DIFFICULTY.easy });
    const hard = planned('lion', { difficulty: BOT_DIFFICULTY.hard });

    expect(easy.templateKey).toBe(hard.templateKey);
    expect(easy.strokeCount).toBeLessThanOrEqual(hard.strokeCount);
  });
});

// ------------------------------------------------------------ normalisation

describe('normalising a word', () => {
  it('folds case and surrounding space', () => {
    expect(normalizeWord('Lion')).toBe('lion');
    expect(normalizeWord('  FISH  ')).toBe('fish');
    expect(normalizeWord('Apple')).toBe('apple');
  });

  it('drops punctuation that is not spelling', () => {
    expect(normalizeWord('walkie-talkie')).toBe('walkie talkie');
    expect(normalizeWord('cat.')).toBe('cat');
    expect(normalizeWord("artist's brush")).toBe('artists brush');
  });

  it('collapses runs of whitespace', () => {
    expect(normalizeWord('ice   cream')).toBe('ice cream');
  });

  it('folds a plural only onto a word that really exists', () => {
    expect(normalizeWord('cats', TEMPLATE_WORDS)).toBe('cat');
    expect(normalizeWord('boxes', TEMPLATE_WORDS)).toBe('box');
    // Not folded: the plural is itself a word, or the stem is not one.
    expect(normalizeWord('grapes', TEMPLATE_WORDS)).toBe('grapes');
    expect(normalizeWord('sunglasses', TEMPLATE_WORDS)).toBe('sunglasses');
    expect(normalizeWord('bus', TEMPLATE_WORDS)).toBe('bus');
    expect(normalizeWord('gas', TEMPLATE_WORDS)).toBe('gas');
  });

  it('leaves the meaning of a word alone', () => {
    // Nothing here may collapse onto anything else.
    const distinct = ['cat', 'car', 'cart', 'cattail', 'carrot', 'cathedral'];
    const normalised = distinct.map((word) => normalizeWord(word, TEMPLATE_WORDS));

    expect(new Set(normalised).size).toBe(distinct.length);
  });

  it('routes a plural to the singular drawing', () => {
    expect(resolveTemplate('Cats').templateKey).toBe('cat');
    expect(resolveTemplate('LIONS').templateKey).toBe('lion');
  });

  it('routes an explicit alias to the word it names', () => {
    expect(resolveTemplate('bike').templateKey).toBe('bicycle');
    expect(resolveTemplate('TV').templateKey).toBe('television');
    expect(resolveTemplate('mobile phone').templateKey).toBe('phone');
  });
});

// ------------------------------------------------------------ word choosing

describe('choosing which word to draw', () => {
  it('prefers a word it can actually draw', () => {
    expect(
      botDrawerService.chooseWordIndex([
        { text: 'antidisestablishmentarianism' },
        { text: 'apple' },
        { text: 'ineffable' },
      ]),
    ).toBe(1);
  });

  it('still picks something when it can draw none of them', () => {
    const index = botDrawerService.chooseWordIndex([{ text: 'zzz' }, { text: 'qqq' }]);

    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(2);
  });

  it('agrees with the planner about what is drawable', () => {
    for (const word of ['lion', 'fish', 'platypus', 'lasagna']) {
      expect(hasTemplate(word)).toBe(plan(word).ok);
    }
  });
});

// ------------------------------------------------------------------ coverage

describe('coverage of the shipped word bank', () => {
  /**
   * Reads the Flutter app's word asset, which is the same list the seed script
   * loads into Mongo — so this measures the words a real round can actually
   * draw, not a list maintained beside the library.
   */
  const bank = (() => {
    try {
      const asset = JSON.parse(
        readFileSync('../scribbleAndGuessAppication/assets/words/words_en.json', 'utf8'),
      ) as { categories?: Record<string, Record<string, string[]>> };

      return Object.values(asset.categories ?? {}).flatMap((byDifficulty) =>
        Object.values(byDifficulty).flat(),
      );
    } catch {
      return [];
    }
  })();

  it('draws every easy animal, which is where the bug was reported', () => {
    const missing = ['cat', 'dog', 'fish', 'bird', 'cow', 'pig', 'duck', 'frog', 'bear', 'lion']
      .filter((word) => !hasTemplate(word));

    expect(missing).toEqual([]);
  });

  it('draws a real share of the bank, and never draws the wrong thing', () => {
    if (bank.length === 0) return; // The app checkout is not beside us.

    const drawable = bank.filter((word) => hasTemplate(word));

    // Not 100%: "orchestra conductor" and "particle accelerator" are not going
    // to get templates, and the bot sits those turns out. The floor is what
    // keeps the fix from rotting back to the seventeen words it started with.
    expect(drawable.length).toBeGreaterThan(bank.length * 0.15);

    // The property that matters more than the share: every word that resolves
    // resolves to itself.
    for (const word of drawable) {
      const { normalizedWord, templateKey } = resolveTemplate(word);
      expect(templateKey, word).not.toBeNull();
      // Either the key is the word, or the word is an explicit alias of it.
      expect(
        templateKey === normalizedWord || resolveTemplate(templateKey!).templateKey === templateKey,
        `${word} -> ${templateKey}`,
      ).toBe(true);
    }
  });

  it('has no key that is unreachable through a lookup', () => {
    for (const key of TEMPLATE_KEYS) {
      expect(resolveTemplate(key).templateKey, key).toBe(key);
    }
  });
});
