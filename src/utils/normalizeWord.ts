import { normalizeGuess } from '@/utils/normalizeGuess';

/**
 * The one normalisation used to look a word up in a library.
 *
 * ## Why this is not `normalizeGuess`
 *
 * `normalizeGuess` judges a player's answer, and it is deliberately
 * conservative: it folds case and accents but keeps punctuation, because
 * "t-shirt" and "tshirt" are different answers and collapsing them would let a
 * wrong guess score. Nothing is *scored* here — the question is only "which
 * drawing does this word mean" — so the hyphen in "walkie-talkie" and the
 * apostrophe in "artist's brush" are noise, and keeping them would mean a word
 * with a template silently missing it.
 *
 * Building on `normalizeGuess` rather than beside it keeps the two agreeing on
 * the hard parts — Latin accent folding, and the Indic vowel signs that must
 * *not* be stripped — which is the part that would quietly rot if it were
 * written twice.
 *
 * ## What it does, in order
 *
 * 1. Fold case and Latin accents, and collapse whitespace (`normalizeGuess`).
 * 2. Turn the separators `-`, `_` and `/` into spaces.
 * 3. Drop decorative punctuation entirely.
 * 4. Collapse whitespace again and trim, because steps 2 and 3 create runs.
 * 5. Optionally fold a plural to its singular — but only for a singular the
 *    caller has explicitly said it supports. See below.
 *
 * ```
 * normalizeWord('Lion')        === 'lion'
 * normalizeWord('  FISH  ')    === 'fish'
 * normalizeWord('Walkie-Talkie') === 'walkie talkie'
 * ```
 *
 * ## Why plurals need an explicit list
 *
 * Stripping a trailing `s` is wrong far more often than it is right: "bus"
 * would become "bu", "glass" "glas", "grapes" "grape", "sunglasses"
 * "sunglasse". None of those mean anything, and one of them — "grapes" — is a
 * real word in the bank whose meaning the strip would destroy.
 *
 * So the fold happens only when the caller passes the set of words it actually
 * has, and only when three things hold: the plural is *not* itself in the set
 * (so "grapes" and "sunglasses" keep their own entries), the singular *is*,
 * and the word is long enough that the stem is a word rather than a fragment.
 * That is "explicitly supported" in the only form that cannot drift: the list
 * is the library itself.
 */
export function normalizeWord(word: string, known?: ReadonlySet<string>): string {
  const folded = normalizeGuess(word);

  const cleaned = folded
    // Separators join two words; they become the space that already joins them.
    .replace(/[-_/\\]+/g, ' ')
    // Everything else that is punctuation rather than spelling.
    .replace(/['’`".,!?;:()[\]{}*&^%$#@~+=<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!known || known.has(cleaned)) return cleaned;

  return singularise(cleaned, known);
}

/**
 * The plural fold, kept separate so the rule is readable.
 *
 * `-es` is tried before `-s` because "boxes" must reach "box" rather than
 * "boxe", and both are gated on the stem being a word the caller knows.
 */
function singularise(word: string, known: ReadonlySet<string>): string {
  if (!word.endsWith('s')) return word;

  const esStem = word.slice(0, -2);
  if (word.endsWith('es') && esStem.length >= MIN_STEM && known.has(esStem)) return esStem;

  const sStem = word.slice(0, -1);
  if (sStem.length >= MIN_STEM && known.has(sStem)) return sStem;

  return word;
}

/**
 * The shortest stem a plural fold will accept.
 *
 * Three, because every two-letter stem this could produce ("bu" from "bus",
 * "ga" from "gas") is a fragment rather than a word, and no template word is
 * shorter than three letters.
 */
const MIN_STEM = 3;
