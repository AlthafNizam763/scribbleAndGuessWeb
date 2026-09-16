import type { LanguageWire, WordCategoryWire } from '@/constants/room.constants';
import { wordRepository, type WordPoolEntry } from '@/repositories/word.repository';
import type { RoomSettingsDto } from '@/types/room.types';
import { normalizeGuess } from '@/utils/normalizeGuess';
import { sample, shuffled } from '@/utils/random';
import { logger } from '@/utils/logger';
import { containsProfanity } from '@/utils/wordFilter';

/**
 * Word selection and hints (brief sections 20, 22 and 34).
 *
 * ## Caching
 *
 * A pool is every word for one language and category set — up to a few
 * thousand rows, read at the start of every single turn. Re-querying Mongo
 * each time would put a database round trip in the middle of the turn
 * transition, which is exactly where latency is most visible. The pool is
 * static data, so it is cached in memory for a few minutes, keyed by the query
 * that produced it.
 */

interface CacheEntry {
  pool: WordPoolEntry[];
  expiresAt: number;
}

const POOL_CACHE_TTL_MS = 5 * 60 * 1000;
const poolCache = new Map<string, CacheEntry>();

function cacheKey(language: LanguageWire, categories: readonly WordCategoryWire[]): string {
  return `${language}:${[...categories].sort().join(',')}`;
}

export class WordService {
  /** Drops the cache. Used by the seed script and by tests. */
  clearCache(): void {
    poolCache.clear();
  }

  /** Loads (and caches) the pool a room's settings allow. */
  async pool(settings: RoomSettingsDto): Promise<WordPoolEntry[]> {
    const key = cacheKey(settings.language, settings.categories);
    const cached = poolCache.get(key);
    const now = Date.now();

    if (cached && cached.expiresAt > now) return cached.pool;

    const pool = await wordRepository.pool({
      language: settings.language,
      categories: settings.categories,
    });

    poolCache.set(key, { pool, expiresAt: now + POOL_CACHE_TTL_MS });
    return pool;
  }

  /**
   * Picks the words to offer the drawer.
   *
   * Words already played this match are excluded, so a three-round game never
   * asks anyone to draw the same thing twice. When exclusions leave too few
   * words the filter is dropped rather than offering fewer choices — a short
   * word list should degrade into repeats, not into a broken turn.
   *
   * `customWords` from the host replace the pool entirely when the room is set
   * up that way, which is what makes a themed private game possible.
   */
  async pickChoices(input: {
    settings: RoomSettingsDto;
    usedWords: ReadonlySet<string>;
    count: number;
  }): Promise<(WordPoolEntry & { aliases: string[] })[]> {
    const { settings, usedWords, count } = input;

    // Custom words go through the same profanity mask as chat. A host cannot
    // be allowed to make the whole room draw a slur, and unlike chat there is
    // nobody to report afterwards — the word simply would not have been in
    // the game. Refused at the source rather than masked, because a starred
    // word is not drawable.
    const custom = settings.customWords
      .map((word) => word.trim())
      .filter((word) => word.length > 0 && !containsProfanity(word))
      .map<WordPoolEntry>((word) => ({
        text: word,
        category: 'random',
        difficulty: 'medium',
        aliases: [],
      }));

    const pool = custom.length > 0 ? custom : await this.pool(settings);

    if (pool.length === 0) {
      logger.warn('word pool is empty; falling back to the built-in list', {
        language: settings.language,
        categories: settings.categories,
      });
      return sample(FALLBACK_POOL, count);
    }

    // The difficulty filter, which is what makes Challenge mode Challenge.
    //
    // Narrowed *before* the freshness filter and relaxed independently of it,
    // because the two failures are different: running out of hard words should
    // fall back to the whole pool rather than to hard words already played.
    const byDifficulty =
      settings.wordDifficulty === null || settings.wordDifficulty === undefined
        ? pool
        : pool.filter((entry) => entry.difficulty === settings.wordDifficulty);

    // A narrowed pool too small to fill a turn is dropped rather than offering
    // fewer choices: a word bank thin in one difficulty should degrade into
    // mixed difficulty, not into a broken turn.
    const eligible = byDifficulty.length >= count ? byDifficulty : pool;

    const fresh = eligible.filter((entry) => !usedWords.has(normalizeGuess(entry.text)));
    const source = fresh.length >= count ? fresh : eligible;

    return sample(source, Math.min(count, source.length));
  }

  /**
   * Picks one word without asking the drawer.
   *
   * Used when word selection times out: the turn takes the first offered word
   * rather than stalling. A drawer who walked away should not freeze the room.
   */
  autoSelect<T>(choices: readonly T[]): T | undefined {
    return shuffled(choices)[0];
  }
}

/**
 * A last-resort word list.
 *
 * Reached only when the `words` collection is empty — an unseeded database.
 * Without it a fresh checkout would start a game and immediately fail with no
 * word to draw, which reads as a broken server rather than a missing seed.
 */
const FALLBACK_POOL: WordPoolEntry[] = [
  { text: 'cat', category: 'animals', difficulty: 'easy', aliases: [] },
  { text: 'house', category: 'objects', difficulty: 'easy', aliases: [] },
  { text: 'tree', category: 'nature', difficulty: 'easy', aliases: [] },
  { text: 'car', category: 'vehicles', difficulty: 'easy', aliases: [] },
  { text: 'pizza', category: 'food', difficulty: 'easy', aliases: [] },
  { text: 'guitar', category: 'music', difficulty: 'medium', aliases: [] },
  { text: 'rocket', category: 'vehicles', difficulty: 'medium', aliases: [] },
  { text: 'elephant', category: 'animals', difficulty: 'medium', aliases: [] },
  { text: 'lighthouse', category: 'places', difficulty: 'hard', aliases: [] },
  { text: 'telescope', category: 'technology', difficulty: 'hard', aliases: [] },
];

export const wordService = new WordService();
