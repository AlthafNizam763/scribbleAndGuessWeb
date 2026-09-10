import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `POST /api/rooms/join` — take a seat in a room by code. */
export const POST = withErrorHandling((request: Request) => roomController.join(request));

export const dynamic = 'force-dynamic';
