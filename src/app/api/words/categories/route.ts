import { wordController } from '@/controllers/word.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/words/categories` — category names and counts. Never the words. */
export const GET = withErrorHandling((request: Request) => wordController.categories(request));

export const dynamic = 'force-dynamic';
