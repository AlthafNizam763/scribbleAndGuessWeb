import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { connectToDatabase } from '@/config/database';
import { LANGUAGES, WORD_CATEGORIES } from '@/constants/room.constants';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { parseQuery } from '@/middleware/validation.middleware';
import { wordRepository } from '@/repositories/word.repository';

const querySchema = z.object({
  language: z.enum(LANGUAGES).catch('en').default('en'),
});

/**
 * Word metadata (brief section 20).
 *
 * ## What this deliberately does not expose
 *
 * There is no endpoint that returns words. Categories and counts, yes — the
 * create-room screen needs those to show which categories are worth picking —
 * but never the list itself. An endpoint returning the pool would let any
 * authenticated player download every possible answer, and while that does not
 * reveal *this* round's word, it turns guessing into a lookup.
 *
 * Words reach a client exactly once: the two-to-five choices sent privately to
 * a drawer.
 */
export const wordController = {
  /** `GET /api/words/categories?language=en` */
  async categories(request: Request): Promise<NextResponse> {
    await requireUser(request);
    await connectToDatabase();

    const { language } = parseQuery(request, querySchema);
    const breakdown = await wordRepository.categoryBreakdown(language);

    const counts = new Map(breakdown.map((row) => [row._id, row.count]));

    return ok({
      language,
      categories: WORD_CATEGORIES.map((category) => ({
        category,
        count: counts.get(category) ?? 0,
      })),
      total: breakdown.reduce((sum, row) => sum + row.count, 0),
    });
  },

  /** `GET /api/words/stats?language=en` */
  async stats(request: Request): Promise<NextResponse> {
    await requireUser(request);
    await connectToDatabase();

    const { language } = parseQuery(request, querySchema);

    return ok({
      language,
      total: await wordRepository.countByLanguage(language),
      languages: LANGUAGES,
    });
  },
};
