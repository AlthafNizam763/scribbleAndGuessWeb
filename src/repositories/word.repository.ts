import type {
  LanguageWire,
  WordCategoryWire,
  WordDifficultyWire,
} from '@/constants/room.constants';
import { Word } from '@/models/Word';

/** One word as the game engine uses it. */
export interface WordPoolEntry {
  text: string;
  category: WordCategoryWire;
  difficulty: WordDifficultyWire;
  aliases: string[];
}

/** Data access for `words`. */
export const wordRepository = {
  /**
   * Loads the pool a room may draw from.
   *
   * An empty `categories` means "any category", which is what the client sends
   * when the host has not narrowed the selection. `random` is treated the same
   * way rather than as a literal category, because that is what it means in
   * the UI: the picker offers it as "surprise me", not as a bucket of words.
   */
  async pool(input: {
    language: LanguageWire;
    categories: readonly WordCategoryWire[];
  }): Promise<WordPoolEntry[]> {
    const named = input.categories.filter((category) => category !== 'random');

    const documents = await Word.find({
      language: input.language,
      isActive: true,
      ...(named.length > 0 ? { category: { $in: named } } : {}),
    })
      .select('word category difficulty aliases')
      .lean()
      .exec();

    return documents.map((doc) => ({
      text: doc.word,
      category: doc.category as WordCategoryWire,
      difficulty: doc.difficulty as WordDifficultyWire,
      aliases: doc.aliases ?? [],
    }));
  },

  async countByLanguage(language: LanguageWire): Promise<number> {
    return Word.countDocuments({ language, isActive: true }).exec();
  },

  /** Category counts, for `GET /api/words/categories`. */
  async categoryBreakdown(language: LanguageWire) {
    return Word.aggregate<{ _id: string; count: number }>([
      { $match: { language, isActive: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).exec();
  },

  /**
   * Inserts or updates many words at once, for the seed script.
   *
   * `bulkWrite` with upserts keyed on `(word, language)` makes re-seeding
   * idempotent: running the script twice leaves one row per word, not two.
   */
  async upsertMany(
    entries: {
      word: string;
      category: WordCategoryWire;
      difficulty: WordDifficultyWire;
      language: LanguageWire;
      aliases: string[];
    }[],
  ): Promise<{ inserted: number; updated: number }> {
    if (entries.length === 0) return { inserted: 0, updated: 0 };

    const result = await Word.bulkWrite(
      entries.map((entry) => ({
        updateOne: {
          filter: { word: entry.word, language: entry.language },
          update: {
            $set: {
              category: entry.category,
              difficulty: entry.difficulty,
              aliases: entry.aliases,
              isActive: true,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    return { inserted: result.upsertedCount, updated: result.modifiedCount };
  },
};
