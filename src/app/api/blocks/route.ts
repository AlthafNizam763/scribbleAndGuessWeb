import { blockController } from '@/controllers/block.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/blocks?page=&limit=` — who the caller has blocked.
 *
 * Their own list only. There is deliberately no endpoint for "who has blocked
 * me": a block is never disclosed to the person it was placed on.
 */
export const GET = withErrorHandling((request: Request) => blockController.list(request));

export const dynamic = 'force-dynamic';
