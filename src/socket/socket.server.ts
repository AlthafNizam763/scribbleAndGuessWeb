import type { Server as HttpServer } from 'node:http';

import { createSocketServer } from '@/config/socket';
import { TIMING } from '@/constants/game.constants';
import { SERVER_TIME_SYNC } from '@/constants/socket.constants';
import { invitationService } from '@/services/invitation.service';
import { presenceService } from '@/services/presence.service';
import { registerChatHandlers } from '@/socket/chat.socket';
import { registerDrawingHandlers } from '@/socket/drawing.socket';
import { registerGameHandlers } from '@/socket/game.socket';
import { registerPresenceHandlers } from '@/socket/presence.socket';
import { registerRoomHandlers } from '@/socket/room.socket';
import { registerVoiceHandlers } from '@/socket/voice.socket';
import { installSocketAuth } from '@/socket/socket.auth';
import type { GameServer, GameSocket } from '@/types/socket.types';
import { logger } from '@/utils/logger';

/**
 * Boots the realtime server (brief sections 14 to 16).
 *
 * Attached to the same HTTP server Next.js is serving from, so one port
 * carries both the REST API and the websocket. That is what keeps deployment
 * simple and what makes the reverse-proxy story in brief section 68 a matter
 * of forwarding one origin with upgrade headers rather than two services.
 */

let started = false;

export function attachSocketServer(httpServer: HttpServer): GameServer {
  const io = createSocketServer(httpServer);

  // Rejects unauthenticated sockets before any handler can run.
  installSocketAuth(io);

  io.on('connection', (socket) => {
    const gameSocket = socket as GameSocket;

    logger.debug('socket connected', { userId: gameSocket.data.user.id });

    registerPresenceHandlers(gameSocket);
    registerRoomHandlers(gameSocket);
    registerGameHandlers(gameSocket);
    registerDrawingHandlers(gameSocket);
    registerChatHandlers(gameSocket);
    registerVoiceHandlers(gameSocket);

    // Seeds the client's clock estimate immediately, so a countdown is
    // displayable before the first `c:time:ping` round trip completes.
    gameSocket.emit(SERVER_TIME_SYNC, { serverTimeMs: Date.now() });
  });

  if (!started) {
    started = true;

    // A one-way clock broadcast. The client folds it in with a small weight
    // because it carries no round-trip information; the ping/pong measurement
    // stays in charge of the offset.
    const clock = setInterval(() => {
      io.emit(SERVER_TIME_SYNC, { serverTimeMs: Date.now() });
    }, TIMING.timeSyncIntervalMs);
    clock.unref?.();

    presenceService.startSweeper();

    // Retires invitations nobody answered. On its own interval rather than
    // folded into the room sweep because the two are unrelated: an invitation
    // lapses on its own clock whether or not any room changed, and the room
    // sweep runs twice as often as this needs to.
    //
    // Correctness never depends on it. The accept path compares against
    // `expiresAt` directly, so a lapsed invitation is refused whether or not
    // the sweeper has reached it; what this buys is releasing the unique-index
    // slot, so the same friend can be invited to that room again.
    const invitations = setInterval(() => {
      void invitationService.expireLapsed();
    }, TIMING.invitationSweepIntervalMs);
    invitations.unref?.();
  }

  logger.info('socket.io attached');
  return io;
}
