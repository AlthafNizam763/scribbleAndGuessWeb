import { connectToDatabase } from '@/config/database';
import { userChannel } from '@/constants/socket.constants';
import { authService } from '@/services/auth.service';
import type { GameServer, GameSocket } from '@/types/socket.types';
import { AppError } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Socket authentication (brief section 14).
 *
 * ## Authenticated before a single event is handled
 *
 * The JWT is verified in a connection middleware, so a socket that fails
 * never reaches a handler. The alternative — authenticating inside `c:hello` —
 * would leave a window where an unauthenticated socket is connected and
 * emitting, and every handler would have to re-check.
 *
 * The identity comes from the token and only from the token. The client also
 * sends a profile on `c:hello`, but that is display data: the id it contains
 * is ignored in favour of the token's subject, so a client cannot act as
 * somebody else by putting their id in a payload (brief section 52).
 *
 * ## Where the token comes from
 *
 * `auth.token` in the handshake, which is where `socket_io_client` puts it.
 * A query parameter is accepted as a fallback for tooling and curl-style
 * debugging; the header form is accepted too.
 */

/** Digs the token out of the handshake, whichever way it was supplied. */
function extractToken(socket: GameSocket): string | null {
  const auth = socket.handshake.auth as Record<string, unknown> | undefined;

  const candidates: unknown[] = [
    auth?.token,
    auth?.idToken,
    auth?.accessToken,
    socket.handshake.query?.token,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }

  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string') {
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token.trim();
  }

  return null;
}

/**
 * Installs the handshake middleware.
 *
 * A rejection here surfaces on the client as `connect_error`, which the
 * Flutter `SocketService` already maps to a network failure and reports
 * through its status stream.
 */
export function installSocketAuth(io: GameServer): void {
  io.use(async (socket, next) => {
    try {
      const token = extractToken(socket as GameSocket);
      if (!token) {
        next(new Error('AUTH_REQUIRED'));
        return;
      }

      await connectToDatabase();
      const user = await authService.authenticate(token);

      socket.data.user = user;
      socket.data.roomId = null;
      socket.data.buckets = new Map();

      // Every socket joins a channel named for its user, which is what lets
      // the server address a player rather than a connection: word choices go
      // to all of a drawer's devices, and a kick reaches every one of them.
      socket.join(userChannel(user.id));

      next();
    } catch (error) {
      const code = AppError.isAppError(error) ? error.code : 'AUTH_ERROR';
      logger.debug('socket handshake rejected', { code });
      next(new Error(code));
    }
  });
}
