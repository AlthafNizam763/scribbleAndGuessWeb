import { discoveryController } from '@/controllers/discovery.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/rooms/discover` — Quick Match.
 *
 * Every joinable public room, across every game, in one list. A static segment
 * beside the `[roomId]` one, so Next matches this before the dynamic route —
 * the same arrangement `/api/rooms/public` and `/api/rooms/join` already rely
 * on.
 *
 * `/api/rooms/public` stays as it is: it is the Scribble & Guess browser, it is
 * what the existing room screen calls, and narrowing to one game is a thing
 * clients still legitimately want.
 */
export const GET = withErrorHandling((request: Request) => discoveryController.publicRooms(request));

export const dynamic = 'force-dynamic';
