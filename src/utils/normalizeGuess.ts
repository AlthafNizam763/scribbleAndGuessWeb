import { CLOSE_GUESS_MIN_LENGTH } from '@/constants/game.constants';
import type { VerdictWire } from '@/constants/room.constants';

/**
 * Guess comparison, mirroring `lib/core/rules/guess_matcher.dart`.
 *
 * The server is the only judge of a guess (brief section 52), but the client
 * runs the same rules in offline practice mode, so the two implementations
 * have to agree exactly or a player would learn one set of rules and be
 * marked wrong by the other.
 *
 * ## Normalisation
 *
 * Case is folded, accents are stripped, and runs of whitespace collapse to one
 * space. That is what makes `"Guitar"`, `" guitar "` and `"GUITAR"` the same
 * answer (brief section 30). Punctuation is *not* stripped wholesale: some
 * words legitimately contain a hyphen or an apostrophe, and removing them
 * would make "t-shirt" and "tshirt" indistinguishable from words that really
 * differ. Aliases cover the spellings that matter instead.
 */

/**
 * Folds Latin-1 and common Latin Extended-A letters onto ASCII.
 *
 * `String.normalize('NFD')` plus a combining-mark strip would handle most of
 * this in one line, but not `ø`, `æ`, `ð` or `ß`, which carry no combining
 * mark. Doing both — decompose first, then map the leftovers — covers the set
 * the Dart implementation covers.
 */
const FOLDING: Readonly<Record<string, string>> = Object.freeze({
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ð: 'd',
  þ: 'th',
  ß: 'ss',
  ł: 'l',
  đ: 'd',
  ħ: 'h',
  ı: 'i',
  ŋ: 'n',
});

/** Whether a character is a Latin letter that accents may be folded off. */
const LATIN_BASE = /[A-Za-zÀ-ɏ]/;

/**
 * Lower-cases, strips Latin accents and collapses whitespace.
 *
 * ## Why combining marks are not stripped globally
 *
 * The obvious implementation — decompose to NFD and delete every `\p{Mn}` —
 * is wrong for the non-Latin word banks the app ships. In Malayalam, Hindi and
 * other Indic scripts a vowel sign *is* a nonspacing mark: `കടുവ` (tiger)
 * decomposes to `കട` + `ു` + `വ`, and deleting the mark yields `കടവ`, a
 * different word. That is not merely cosmetic — two distinct words could
 * normalise to the same string and a wrong guess would be scored as correct.
 *
 * So marks are dropped only when they sit on a Latin base, which is where they
 * are genuinely decorative for guessing purposes (`café` and `cafe` are the
 * same answer). Everything else recomposes to NFC and is compared as written.
 */
export function normalizeGuess(value: string): string {
  const decomposed = value.toLowerCase().normalize('NFD');

  let out = '';
  let baseIsLatin = false;

  for (const char of decomposed) {
    if (COMBINING_MARK.test(char)) {
      // An accent on a Latin letter is noise; a vowel sign in an Indic script
      // is part of the word.
      if (!baseIsLatin) out += char;
      continue;
    }

    baseIsLatin = LATIN_BASE.test(char);
    out += FOLDING[char] ?? char;
  }

  // Recompose, so a non-Latin base and its marks compare as one sequence.
  return out.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Non-spacing marks.
 *
 * Declared once rather than inline: a regex literal with the `g` flag carries
 * mutable `lastIndex` state between calls, and this one is tested per
 * character in a loop. Without `g` there is no state to leak.
 */
const COMBINING_MARK = /\p{Mn}/u;

/**
 * Levenshtein edit distance, with the usual two-row optimisation.
 *
 * `limit` short-circuits once every cell in a row exceeds it. Callers only
 * ever ask "is this distance exactly 1?", so bailing out early turns a long
 * wrong guess from an O(n*m) scan into an O(n) one — worth having when this
 * runs on every chat line of every room.
 */
export function levenshtein(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Iterate over the longer string's rows so the row buffers stay small.
  const [rows, columns] = a.length >= b.length ? [a, b] : [b, a];
  const width = columns.length;

  let previous = Array.from({ length: width + 1 }, (_, i) => i);
  let current = new Array<number>(width + 1).fill(0);

  for (let i = 1; i <= rows.length; i++) {
    current[0] = i;
    let rowBest = i;
    const rowChar = rows.charCodeAt(i - 1);

    for (let j = 1; j <= width; j++) {
      const cost = rowChar === columns.charCodeAt(j - 1) ? 0 : 1;
      const substitution = previous[j - 1]! + cost;
      const deletion = previous[j]! + 1;
      const insertion = current[j - 1]! + 1;
      const best = Math.min(substitution, deletion, insertion);
      current[j] = best;
      if (best < rowBest) rowBest = best;
    }

    if (rowBest > limit) return limit + 1;

    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[width]!;
}

/**
 * Judges a guess against the answer and its aliases.
 *
 * An alias match counts as fully `correct`: aliases exist precisely so that
 * "TV" and "television" are the same answer. Closeness, though, is measured
 * only against the real word — telling a player they are one letter away from
 * an alias they never saw would be baffling.
 *
 * `close` is what drives the client's "so close!" chat line. It is never
 * scored and never revealed to anybody but the guesser.
 */
export function evaluateGuess(
  guess: string,
  word: string,
  aliases: readonly string[] = [],
): VerdictWire {
  const normalizedGuess = normalizeGuess(guess);
  const normalizedWord = normalizeGuess(word);

  if (normalizedGuess.length === 0 || normalizedWord.length === 0) return 'wrong';
  if (normalizedGuess === normalizedWord) return 'correct';

  for (const alias of aliases) {
    if (normalizeGuess(alias) === normalizedGuess) return 'correct';
  }

  if (
    normalizedWord.length >= CLOSE_GUESS_MIN_LENGTH &&
    levenshtein(normalizedGuess, normalizedWord, 1) === 1
  ) {
    return 'close';
  }

  return 'wrong';
}
