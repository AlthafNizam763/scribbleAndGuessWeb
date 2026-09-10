import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `POST /api/rooms` — create a room and become its host. */
export const POST = withErrorHandling((request: Request) => roomController.create(request));

export const dynamic = 'force-dynamic';
