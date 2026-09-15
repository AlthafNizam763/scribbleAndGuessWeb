import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/rooms/public` — the joinable public rooms.
 *
 * A static segment beside the `[roomId]` one, so Next matches this before the
 * dynamic route — the same arrangement `/api/rooms/join` already relies on.
 */
export const GET = withErrorHandling((request: Request) => roomController.publicRooms(request));

export const dynamic = 'force-dynamic';
