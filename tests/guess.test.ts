import { describe, expect, it } from 'vitest';

import { evaluateGuess, levenshtein, normalizeGuess } from '@/utils/normalizeGuess';

/**
 * Guess matching (brief sections 30 and 65).
 *
 * The cases here are the ones players actually hit: trailing spaces from a
 * mobile keyboard's autocomplete, capitalisation, accents typed or not typed,
 * and the one-letter typo that should feel like a near miss rather than a
 * flat rejection.
 */

describe('normalizeGuess', () => {
  it('folds case and trims', () => {
    expect(normalizeGuess('  GUITAR ')).toBe('guitar');
    expect(normalizeGuess('Guitar')).toBe('guitar');
  });

  it('collapses runs of whitespace', () => {
    expect(normalizeGuess('ice    cream')).toBe('ice cream');
    expect(normalizeGuess('ice\tcream')).toBe('ice cream');
  });

  it('strips accents', () => {
    expect(normalizeGuess('café')).toBe('cafe');
    expect(normalizeGuess('piñata')).toBe('pinata');
    expect(normalizeGuess('ÀÉÎÕÜ')).toBe('aeiou');
  });

  it('folds letters that carry no combining mark', () => {
    // NFD alone would leave these untouched.
    expect(normalizeGuess('Ærø')).toBe('aero');
    expect(normalizeGuess('straße')).toBe('strasse');
  });

  it('leaves non-Latin scripts alone apart from whitespace', () => {
    // The app ships Malayalam, Hindi, Japanese and Russian word banks; there
    // is no ASCII to fold these onto and mangling them would break those games.
    expect(normalizeGuess(' കടുവ ')).toBe('കടുവ');
    expect(normalizeGuess('  кот ')).toBe('кот');
  });

  it('keeps hyphens and apostrophes', () => {
    // Stripping them would make "t-shirt" and a genuinely different word
    // indistinguishable.
    expect(normalizeGuess('T-Shirt')).toBe('t-shirt');
  });
});

describe('levenshtein', () => {
  it('is zero for identical strings', () => {
    expect(levenshtein('guitar', 'guitar')).toBe(0);
  });

  it('counts a single edit', () => {
    expect(levenshtein('guitar', 'guitr')).toBe(1);
    expect(levenshtein('guitar', 'guitars')).toBe(1);
    expect(levenshtein('guitar', 'gultar')).toBe(1);
  });

  it('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', '')).toBe(0);
  });

  it('reports a value above the limit once it is exceeded', () => {
    // The early bail-out only has to preserve the "is it exactly 1?" answer.
    expect(levenshtein('elephant', 'xyz', 1)).toBeGreaterThan(1);
  });
});

describe('evaluateGuess', () => {
  it('accepts the word in any casing or padding', () => {
    for (const guess of ['guitar', 'Guitar', 'GUITAR', '  guitar  ']) {
      expect(evaluateGuess(guess, 'guitar')).toBe('correct');
    }
  });

  it('accepts an alias', () => {
    expect(evaluateGuess('tv', 'television', ['tv'])).toBe('correct');
    expect(evaluateGuess('TV', 'television', ['tv'])).toBe('correct');
  });

  it('reports a one-letter typo as close', () => {
    expect(evaluateGuess('guitr', 'guitar')).toBe('close');
    expect(evaluateGuess('elephent', 'elephant')).toBe('close');
  });

  it('does not report closeness on short words', () => {
    // On a three-letter word every wrong guess is one edit away from
    // something; "close" would be noise.
    expect(evaluateGuess('bat', 'cat')).toBe('wrong');
    expect(evaluateGuess('dog', 'dig')).toBe('wrong');
  });

  it('measures closeness against the word, not an alias', () => {
    // "t" is one edit from the alias "tv" but nowhere near "television".
    expect(evaluateGuess('t', 'television', ['tv'])).toBe('wrong');
  });

  it('rejects an unrelated guess', () => {
    expect(evaluateGuess('banana', 'guitar')).toBe('wrong');
  });

  it('rejects an empty guess', () => {
    expect(evaluateGuess('', 'guitar')).toBe('wrong');
    expect(evaluateGuess('   ', 'guitar')).toBe('wrong');
  });

  it('matches an accented word typed without accents', () => {
    expect(evaluateGuess('cafe', 'café')).toBe('correct');
    expect(evaluateGuess('CAFÉ', 'cafe')).toBe('correct');
  });

  it('matches a multi-word answer regardless of spacing', () => {
    expect(evaluateGuess('ice   cream', 'ice cream')).toBe('correct');
  });
});
