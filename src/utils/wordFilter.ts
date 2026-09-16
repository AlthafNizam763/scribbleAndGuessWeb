import { normalizeGuess } from '@/utils/normalizeGuess';

/**
 * The bad-word filter for chat (brief section: Chat security).
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a profanity *mask* for the room's chat, not a moderation system. It
 * catches the handful of words that make a family game unpleasant, and it is
 * wrong about edge cases in both directions — every word filter is. The things
 * that actually stop abuse in this app are elsewhere and are not guesses at
 * intent: the rate limiter, the per-room mute, the block list, and reporting.
 *
 * ## Masked, not refused
 *
 * A refused message tells the sender exactly which word tripped the filter and
 * invites them to try variations until one gets through. A masked one shows
 * the room a line of asterisks and gives the sender nothing to iterate against.
 * It is also the kinder failure for a false positive: a legitimate message
 * still arrives, with one word starred.
 *
 * ## The rule that matters most
 *
 * **A guess is never filtered.** The filter runs on chat only, after the game
 * engine has evaluated the text. That ordering is not incidental — if the
 * answer were ever a word on this list, filtering first would make the round
 * unwinnable, and the player would have no way to know why. Word lists are
 * seeded data and this list is code; they can and do overlap.
 */

/**
 * The list.
 *
 * Deliberately short and English-only. A long list borrowed from elsewhere
 * brings a long tail of false positives — place names, surnames, ordinary
 * words in other languages — and this game ships eight of those. The bar for
 * adding one is that seeing it would end the game for somebody.
 *
 * Stored as normalised forms so `normalizeGuess`'s own folding — case,
 * accents, punctuation — is reused rather than reimplemented here.
 */
const BLOCKED = new Set<string>([
  'fuck',
  'fuk',
  'shit',
  'bitch',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'rape',
  'retard',
  'whore',
  'slut',
  'dick',
  'cock',
  'pussy',
  'asshole',
  'bastard',
  'wanker',
]);

/**
 * Characters people substitute to get past a naive filter.
 *
 * Folded before the lookup, so `sh1t` and `f*ck` are caught by the same entry
 * as the plain spelling. This is the only evasion handled: doubled letters,
 * spacing and unicode look-alikes are not, because chasing them is an arms
 * race that ends in false positives on ordinary words.
 */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
};

/**
 * Note what is *not* here: a rule that deletes `*`.
 *
 * It would turn `f*ck` into `fck`, which matches nothing, while also merging
 * unrelated words into each other. And the case it appears to serve does not
 * need serving: somebody typing `f*ck` has already censored themselves, which
 * is the outcome the filter exists to produce. Chasing self-censored spellings
 * buys nothing and costs false positives.
 */

/** Folds one token to the form the list is keyed by. */
function fold(token: string): string {
  const substituted = [...token.toLowerCase()]
    .map((character) => LEET[character] ?? character)
    .join('');

  return normalizeGuess(substituted);
}

/** Whether one already-folded token is on the list. */
function isBlocked(token: string): boolean {
  if (token.length < 3) return false;
  return BLOCKED.has(token);
}

/**
 * Masks any blocked words in [text], preserving everything else.
 *
 * Whole tokens only. A substring match would star the middle of `Scunthorpe`
 * and `assassin`, which is the classic way these filters embarrass themselves.
 */
export function maskProfanity(text: string): { text: string; masked: boolean } {
  let masked = false;

  const result = text
    .split(/(\s+)/)
    .map((token) => {
      if (token.trim().length === 0) return token;
      if (!isBlocked(fold(token))) return token;

      masked = true;
      return '*'.repeat(token.length);
    })
    .join('');

  return { text: result, masked };
}

/** Whether [text] contains anything the filter would mask. */
export function containsProfanity(text: string): boolean {
  return maskProfanity(text).masked;
}
