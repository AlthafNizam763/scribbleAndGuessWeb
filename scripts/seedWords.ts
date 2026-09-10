import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { connectToDatabase, disconnectFromDatabase } from '@/config/database';
import {
  LANGUAGES,
  WORD_CATEGORIES,
  WORD_DIFFICULTIES,
  type LanguageWire,
  type WordCategoryWire,
  type WordDifficultyWire,
} from '@/constants/room.constants';
import { wordRepository } from '@/repositories/word.repository';
import { normalizeGuess } from '@/utils/normalizeGuess';
import { logger } from '@/utils/logger';

/**
 * Seeds the `words` collection (brief section 64).
 *
 * ## Where the words come from
 *
 * The Flutter app already ships a curated, translated word bank at
 * `assets/words/words_<lang>.json` — 720 English words across nine categories,
 * plus seven other languages. Re-typing a list here would mean two lists that
 * drift apart, and the app's own offline practice mode reads the asset
 * version. So the asset files are the source and this script imports them.
 *
 * If the app directory is not found — someone running the backend on its own —
 * it falls back to a small built-in list so a fresh database is still playable.
 *
 * ## Idempotent
 *
 * Upserts keyed on `(word, language)`, so running it repeatedly converges
 * instead of duplicating. Safe to run on every deploy.
 *
 * Usage:
 *   npm run seed
 *   npm run seed -- --language=en --reset
 */

/** The asset shape: `{language, categories: {animals: {easy: [...]}}}`. */
interface WordAsset {
  language?: string;
  categories?: Record<string, Record<string, unknown>>;
}

interface SeedEntry {
  word: string;
  category: WordCategoryWire;
  difficulty: WordDifficultyWire;
  language: LanguageWire;
  aliases: string[];
}

/** Where the Flutter app's word assets live, relative to this project. */
const ASSET_DIRECTORY = resolve(
  process.cwd(),
  '..',
  'scribbleAndGuessAppication',
  'assets',
  'words',
);

/**
 * Aliases the guess engine should accept beyond the word itself.
 *
 * Only the ones that genuinely bite: abbreviations players type by reflex, and
 * compounds they would write as one word. Stored normalised, since that is how
 * they are compared.
 */
const ALIASES: Readonly<Record<string, string[]>> = {
  television: ['tv'],
  telephone: ['phone'],
  'mobile phone': ['phone', 'cellphone', 'cell phone'],
  bicycle: ['bike'],
  motorcycle: ['motorbike', 'bike'],
  aeroplane: ['airplane', 'plane'],
  airplane: ['aeroplane', 'plane'],
  refrigerator: ['fridge'],
  hamburger: ['burger'],
  'french fries': ['fries', 'chips'],
  'ice cream': ['icecream'],
  't-shirt': ['tshirt', 't shirt'],
  sunglasses: ['shades'],
  photograph: ['photo'],
  laboratory: ['lab'],
  hippopotamus: ['hippo'],
  rhinoceros: ['rhino'],
  alligator: ['crocodile'],
  automobile: ['car'],
  skyscraper: ['sky scraper'],
};

function aliasesFor(word: string): string[] {
  const found = ALIASES[word.toLowerCase()] ?? [];
  return found.map(normalizeGuess);
}

/** Parses one asset file into seed entries, skipping anything malformed. */
function parseAsset(raw: string, fallbackLanguage: LanguageWire): SeedEntry[] {
  let parsed: WordAsset;
  try {
    parsed = JSON.parse(raw) as WordAsset;
  } catch {
    logger.warn('skipping an unparseable word asset', { language: fallbackLanguage });
    return [];
  }

  const language = (LANGUAGES as readonly string[]).includes(parsed.language ?? '')
    ? (parsed.language as LanguageWire)
    : fallbackLanguage;

  const entries: SeedEntry[] = [];
  const seen = new Set<string>();

  for (const [categoryKey, group] of Object.entries(parsed.categories ?? {})) {
    if (!(WORD_CATEGORIES as readonly string[]).includes(categoryKey)) continue;
    const category = categoryKey as WordCategoryWire;

    for (const [difficultyKey, words] of Object.entries(group ?? {})) {
      if (!(WORD_DIFFICULTIES as readonly string[]).includes(difficultyKey)) continue;
      if (!Array.isArray(words)) continue;

      const difficulty = difficultyKey as WordDifficultyWire;

      for (const candidate of words) {
        if (typeof candidate !== 'string') continue;
        const word = candidate.trim();
        if (word.length === 0) continue;

        // A word appearing in two categories would violate the unique index
        // on (word, language); the first listing wins.
        const key = normalizeGuess(word);
        if (seen.has(key)) continue;
        seen.add(key);

        entries.push({ word, category, difficulty, language, aliases: aliasesFor(word) });
      }
    }
  }

  return entries;
}

/** Loads every asset file, optionally narrowed to one language. */
async function loadFromAssets(only?: LanguageWire): Promise<SeedEntry[]> {
  let files: string[];
  try {
    files = await readdir(ASSET_DIRECTORY);
  } catch {
    logger.warn('no Flutter word assets found; using the built-in list', {
      expectedAt: ASSET_DIRECTORY,
    });
    return BUILT_IN;
  }

  const entries: SeedEntry[] = [];

  for (const file of files) {
    const match = /^words_([a-z]{2})\.json$/.exec(file);
    if (!match) continue;

    const language = match[1] as LanguageWire;
    if (!(LANGUAGES as readonly string[]).includes(language)) continue;
    if (only && language !== only) continue;

    const raw = await readFile(join(ASSET_DIRECTORY, file), 'utf8');
    const parsed = parseAsset(raw, language);
    entries.push(...parsed);

    logger.info('read word asset', { file, words: parsed.length });
  }

  return entries.length > 0 ? entries : BUILT_IN;
}

/** A minimal playable set, for when the app's assets are not on disk. */
const BUILT_IN: SeedEntry[] = (
  [
    ['cat', 'animals', 'easy'],
    ['dog', 'animals', 'easy'],
    ['elephant', 'animals', 'medium'],
    ['penguin', 'animals', 'medium'],
    ['octopus', 'animals', 'hard'],
    ['pizza', 'food', 'easy'],
    ['banana', 'food', 'easy'],
    ['hamburger', 'food', 'medium'],
    ['spaghetti', 'food', 'hard'],
    ['chair', 'objects', 'easy'],
    ['umbrella', 'objects', 'medium'],
    ['telescope', 'objects', 'hard'],
    ['beach', 'places', 'easy'],
    ['castle', 'places', 'medium'],
    ['lighthouse', 'places', 'hard'],
    ['titanic', 'movies', 'medium'],
    ['football', 'sports', 'easy'],
    ['basketball', 'sports', 'easy'],
    ['surfing', 'sports', 'medium'],
    ['doctor', 'jobs', 'easy'],
    ['firefighter', 'jobs', 'medium'],
    ['astronaut', 'jobs', 'medium'],
    ['robot', 'technology', 'easy'],
    ['computer', 'technology', 'easy'],
    ['satellite', 'technology', 'hard'],
    ['tree', 'nature', 'easy'],
    ['rainbow', 'nature', 'easy'],
    ['volcano', 'nature', 'medium'],
    ['guitar', 'music', 'medium'],
    ['piano', 'music', 'easy'],
    ['trumpet', 'music', 'medium'],
    ['car', 'vehicles', 'easy'],
    ['bicycle', 'vehicles', 'easy'],
    ['helicopter', 'vehicles', 'medium'],
    ['submarine', 'vehicles', 'hard'],
  ] as const
).map(([word, category, difficulty]) => ({
  word,
  category,
  difficulty,
  language: 'en' as const,
  aliases: aliasesFor(word),
}));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const languageArg = args.find((arg) => arg.startsWith('--language='))?.split('=')[1];
  const reset = args.includes('--reset');

  const only =
    languageArg && (LANGUAGES as readonly string[]).includes(languageArg)
      ? (languageArg as LanguageWire)
      : undefined;

  await connectToDatabase();

  if (reset) {
    const { Word } = await import('@/models/Word');
    const { deletedCount } = await Word.deleteMany(only ? { language: only } : {}).exec();
    logger.info('cleared existing words', { deleted: deletedCount });
  }

  const entries = await loadFromAssets(only);
  logger.info('seeding words', { count: entries.length });

  // Chunked, because one bulkWrite of several thousand operations is a large
  // single request and a partial failure would be hard to reason about.
  const CHUNK = 500;
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < entries.length; i += CHUNK) {
    const result = await wordRepository.upsertMany(entries.slice(i, i + CHUNK));
    inserted += result.inserted;
    updated += result.updated;
  }

  const byLanguage = new Map<string, number>();
  for (const entry of entries) {
    byLanguage.set(entry.language, (byLanguage.get(entry.language) ?? 0) + 1);
  }

  logger.info('seed complete', {
    inserted,
    updated,
    total: entries.length,
    languages: Object.fromEntries(byLanguage),
  });

  await disconnectFromDatabase();
}

main().catch((error: unknown) => {
  logger.exception('seeding failed', error);
  process.exit(1);
});
