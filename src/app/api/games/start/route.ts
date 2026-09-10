import { gameController } from '@/controllers/game.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `POST /api/games/start` — host-only. Shuffles turn order and opens turn 1. */
export const POST = withErrorHandling((request: Request) => gameController.start(request));

export const dynamic = 'force-dynamic';
