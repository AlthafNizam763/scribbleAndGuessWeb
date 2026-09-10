import { wordController } from '@/controllers/word.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/words/stats` — how many words a language has available. */
export const GET = withErrorHandling((request: Request) => wordController.stats(request));

export const dynamic = 'force-dynamic';
