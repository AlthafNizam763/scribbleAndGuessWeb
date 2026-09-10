import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { LANGUAGES, WORD_CATEGORIES, WORD_DIFFICULTIES } from '@/constants/room.constants';

/**
 * One drawable word (brief section 20).
 *
 * ## Aliases
 *
 * `aliases` is what makes guessing feel fair. "television" should accept "tv",
 * "mobile phone" should accept "phone" and "cellphone". Without them players
 * spend the round typing synonyms of something they clearly recognised, which
 * reads as the game being broken rather than strict.
 *
 * They are stored already normalised (lower-cased, accents folded) so the
 * guess engine can compare without re-normalising the whole list on every
 * chat line.
 */

const wordSchema = new Schema(
  {
    word: { type: String, required: true, trim: true },
    category: { type: String, enum: WORD_CATEGORIES, required: true },
    difficulty: { type: String, enum: WORD_DIFFICULTIES, required: true, default: 'medium' },
    language: { type: String, enum: LANGUAGES, required: true, default: 'en' },

    /** Normalised alternate spellings that also count as correct. */
    aliases: { type: [String], default: [] },

    /**
     * Lets a word be retired without deleting it.
     *
     * A deleted word would break the `Round` documents that reference it in
     * game history; a deactivated one simply stops being dealt.
     */
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'words' },
);

/**
 * The index the word selector actually queries.
 *
 * Every pick filters by language, active flag and category, so a compound
 * index in that order lets Mongo serve the pool without a collection scan.
 */
wordSchema.index({ language: 1, isActive: 1, category: 1, difficulty: 1 });

// Makes the seed script idempotent: re-running it upserts rather than
// duplicating, and a word can exist once per language.
wordSchema.index({ word: 1, language: 1 }, { unique: true });

export type WordDocument = InferSchemaType<typeof wordSchema> & { _id: Types.ObjectId };

export const Word: Model<WordDocument> =
  (models.Word as Model<WordDocument>) ?? model<WordDocument>('Word', wordSchema);
