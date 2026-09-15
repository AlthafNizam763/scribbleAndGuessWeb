import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/rooms/invitations?page=&limit=` — the caller's open invitations. */
export const GET = withErrorHandling((request: Request) =>
  roomController.listInvitations(request),
);

export const dynamic = 'force-dynamic';
