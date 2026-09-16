import type { TemplateStroke } from '@/services/bot/drawingShapes';
import { ANIMAL_TEMPLATES } from '@/services/bot/templates/animals';
import { FOOD_TEMPLATES } from '@/services/bot/templates/food';
import { MACHINE_TEMPLATES } from '@/services/bot/templates/machines';
import { NATURE_TEMPLATES } from '@/services/bot/templates/nature';
import { OBJECT_TEMPLATES } from '@/services/bot/templates/objects';
import { PEOPLE_TEMPLATES } from '@/services/bot/templates/people';
import { PLACE_TEMPLATES } from '@/services/bot/templates/places';
import { normalizeWord } from '@/utils/normalizeWord';

export type { TemplateStroke } from '@/services/bot/drawingShapes';

/**
 * What a bot draws, and how a word finds it.
 *
 * ## Why templates and not a generative model
 *
 * A drawing has to be recognisable within eighty seconds by somebody who is
 * also typing. That is a very low bar for a human and a surprisingly high one
 * for anything procedural: a generated sketch of "umbrella" is a shape nobody
 * guesses, and a bot that draws unguessable pictures makes every round it
 * draws in a dead one for the humans in it.
 *
 * So each word has a hand-specified path, in the same normalised 0..1
 * coordinate space the client draws in, and the bot's difficulty decides how
 * much of it gets drawn, how fast, and how shaky the line is. That is where
 * the variation belongs — a HARD bot draws the same apple as an EASY one, more
 * completely and more steadily.
 *
 * ## Why the lookup is exact, and why there is no generic fallback
 *
 * This used to have both a substring fallback and a generic doodle, and
 * together they were the bug: the library covered seventeen of the bank's 720
 * English words, so nine words in ten drew a neutral face — a lion, a fish, a
 * house all came out as the same blob — and the substring rule quietly filled
 * in 42 more with something *wrong*: "carrot" drew a car, "cathedral" drew a
 * cat, "sunglasses" drew a sun. A guesser cannot tell a bot that has nothing
 * to say from a bot that is telling them the wrong thing, and the second is
 * far more expensive: it sends the whole room down a path the answer is not on.
 *
 * So the lookup is exact against `templateKey`, aliases are an explicit list of
 * words that genuinely name the same picture, and a word with no template
 * returns null. The caller logs the gap and the bot draws nothing that turn —
 * an honest blank, which the guessers read correctly as "no help here" and
 * play off the hints, instead of a confident wrong answer in ink.
 *
 * ## Why coordinates are normalised and sit inside a margin
 *
 * The canvas is 4:3 and the client normalises to it, so `[0.5, 0.5]` is the
 * centre on every device. Templates are drawn to sit inside roughly
 * `0.12..0.88` on both axes, which leaves room for the difficulty jitter to
 * push a point outward without it being clamped against an edge and flattening
 * a curve.
 */

/** Every category, merged. The split is for editing, not for lookup. */
const TEMPLATES = Object.freeze({
  ...ANIMAL_TEMPLATES,
  ...FOOD_TEMPLATES,
  ...OBJECT_TEMPLATES,
  ...PLACE_TEMPLATES,
  ...NATURE_TEMPLATES,
  ...MACHINE_TEMPLATES,
  ...PEOPLE_TEMPLATES,
});

/**
 * Words that name the same drawing, and only those.
 *
 * Every entry here has to be a synonym or a spelling — a word a player would
 * be annoyed to learn was drawn differently. Nothing that is merely *related*
 * belongs here: that is the substring rule that caused the bug, written by
 * hand. "sailboat" is a boat; "lifeboat" would also be a boat; "gravy boat" is
 * not, and is absent.
 */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  bike: 'bicycle',
  cycle: 'bicycle',
  tv: 'television',
  telly: 'television',
  auto: 'car',
  automobile: 'car',
  motorcar: 'car',
  cellphone: 'phone',
  'cell phone': 'phone',
  'mobile phone': 'phone',
  smartphone: 'phone',
  telephone: 'phone',
  aeroplane: 'airplane',
  plane: 'airplane',
  aircraft: 'airplane',
  jet: 'airplane',
  'light bulb': 'lightbulb',
  bulb: 'lightbulb',
  sailboat: 'boat',
  ship: 'boat',
  yacht: 'boat',
  lorry: 'truck',
  'pc': 'computer',
  desktop: 'computer',
  monitor: 'computer',
  notebook: 'laptop',
  armchair: 'chair',
  seat: 'chair',
  bunny: 'rabbit',
  hare: 'rabbit',
  puppy: 'dog',
  hound: 'dog',
  kitten: 'cat',
  piglet: 'pig',
  hen: 'chicken',
  rooster: 'chicken',
  'full moon': 'moon',
  'crescent moon': 'moon',
  'shooting star': 'star',
  'palm': 'palm tree',
  'lightning bolt': 'lightning',
  thunderbolt: 'lightning',
  brolly: 'umbrella',
  parasol: 'umbrella',
  shades: 'sunglasses',
  earphones: 'headphones',
  cap: 'hat',
  boot: 'shoe',
  sneaker: 'shoe',
  trainer: 'shoe',
  mug: 'cup',
  loaf: 'bread',
  hamburger: 'burger',
  cheeseburger: 'burger',
  doughnut: 'donut',
  biscuit: 'cookie',
  sweetcorn: 'corn',
  maize: 'corn',
});

/**
 * Every word that resolves to a drawing, including aliases.
 *
 * Exported because two other things need exactly this set and must not build
 * their own: `normalizeWord`'s plural fold, which may only fold onto a word
 * that is really here, and the coverage test.
 */
export const TEMPLATE_WORDS: ReadonlySet<string> = Object.freeze(
  new Set([...Object.keys(TEMPLATES), ...Object.keys(ALIASES)]),
);

/** The canonical keys, without aliases. For the coverage report. */
export const TEMPLATE_KEYS: readonly string[] = Object.freeze(Object.keys(TEMPLATES).sort());

/**
 * A word normalised for template lookup.
 *
 * The single entry point: callers pass the raw server-authoritative word and
 * get back both halves of the pair the validator compares, so there is no way
 * to normalise with one rule and look up with another.
 */
export function resolveTemplate(rawWord: string): {
  /** The word after normalisation — what the log prints as `normalizedWord`. */
  normalizedWord: string;
  /** The canonical template key, or null when nothing draws this word. */
  templateKey: string | null;
} {
  const normalizedWord = normalizeWord(rawWord, TEMPLATE_WORDS);

  const alias = ALIASES[normalizedWord];
  const key = alias ?? normalizedWord;

  return {
    normalizedWord,
    templateKey: Object.hasOwn(TEMPLATES, key) ? key : null,
  };
}

/**
 * The strokes for a canonical key.
 *
 * Built fresh on every call, which matters: a template returned as a shared
 * array would be handed to the jitter step, and a bug there would permanently
 * deform the library for every future round in the process.
 */
export function strokesFor(templateKey: string): TemplateStroke[] {
  const builder = TEMPLATES[templateKey as keyof typeof TEMPLATES];
  return builder ? builder() : [];
}

/** Whether a word has a drawing. Used when a bot picks which word to take. */
export function hasTemplate(rawWord: string): boolean {
  return resolveTemplate(rawWord).templateKey !== null;
}

/**
 * Catches a key defined in two category files.
 *
 * A duplicate is invisible at runtime — the later spread simply wins — and the
 * symptom is one word drawing another word's picture, which is the exact class
 * of bug this module exists to make impossible. Cheap enough to check at
 * import rather than only in a test, because a test only catches it if
 * somebody runs it.
 */
(function assertNoDuplicateKeys(): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const group of [
    ANIMAL_TEMPLATES,
    FOOD_TEMPLATES,
    OBJECT_TEMPLATES,
    PLACE_TEMPLATES,
    NATURE_TEMPLATES,
    MACHINE_TEMPLATES,
    PEOPLE_TEMPLATES,
  ]) {
    for (const key of Object.keys(group)) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
  }

  // An alias that shadows a real key would make the real key unreachable.
  for (const alias of Object.keys(ALIASES)) {
    if (Object.hasOwn(TEMPLATES, alias) && ALIASES[alias] !== alias) duplicates.push(alias);
  }

  if (duplicates.length > 0) {
    throw new Error(`Duplicate bot drawing template keys: ${duplicates.join(', ')}`);
  }
})();
