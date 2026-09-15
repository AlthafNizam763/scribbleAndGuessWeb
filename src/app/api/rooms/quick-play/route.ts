import { roomController } from '@/controllers/room.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `POST /api/rooms/quick-play` — join a public room, or open one.
 *
 * Takes no parameters: the whole point of the button is that there is nothing
 * to decide. Private and in-progress rooms are never matched, and the response
 * says whether the caller was actually seated (`joined`) or merely handed a
 * code to join over the socket — see the controller for why that depends on
 * the deployment.
 */
export const POST = withErrorHandling((request: Request) => roomController.quickPlay(request));

export const dynamic = 'force-dynamic';
