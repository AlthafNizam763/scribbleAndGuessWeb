import type { Server as HttpServer } from 'node:http';

import { Server } from 'socket.io';

import { env } from '@/config/env';
import { roomChannel, userChannel, voiceChannel } from '@/constants/socket.constants';
import type { GameServer, GameSocket } from '@/types/socket.types';
import { logger } from '@/utils/logger';

/**
 * The Socket.IO server instance, and the only way anything reaches a client.
 *
 * ## Why this indirection exists
 *
 * The game services need to broadcast, and the socket handlers need to call
 * the game services. Importing one from the other directly would be a cycle.
 * So the instance is parked here, the handlers set it at boot, and the
 * services reach clients through the small `emit*` helpers below. Nothing
 * outside this module touches `io` directly.
 *
 * ## Why the instance lives on `globalThis`
 *
 * Next.js compiles route handlers into its own bundle, with its own module
 * registry. A module-level `let io` set by `server.ts` would therefore be
 * `null` when a route handler imported this file — the two would be looking at
 * different copies of the module. Every REST-triggered broadcast would go
 * nowhere, silently: joining a room over REST would not tell anybody.
 *
 * `globalThis` is shared by both bundles because they run in one process, so
 * parking the instance there is what makes the REST layer and the socket layer
 * describe the same game. The room registry in `room.service.ts` does the same
 * thing for the same reason.
 *
 * ## Scaling
 *
 * Every broadcast goes to a named Socket.IO room, never to a socket list this
 * process holds. That is what makes the Redis adapter a drop-in later (brief
 * section 68): `io.adapter(createAdapter(pub, sub))` in `attachSocketServer`
 * and the same calls fan out across processes with nothing else changed.
 */

const globalSocket = globalThis as typeof globalThis & {
  __scribbleSocketServer?: GameServer | null;
};

function setInstance(server: GameServer | null): void {
  globalSocket.__scribbleSocketServer = server;
}

function instance(): GameServer | null {
  return globalSocket.__scribbleSocketServer ?? null;
}

/** Creates the server and binds it to the HTTP server Next.js is using. */
export function createSocketServer(httpServer: HttpServer): GameServer {
  const server: GameServer = new Server(httpServer, {
    // Native clients send no Origin header, so this only gates browsers.
    cors: {
      origin: env.corsOrigins === '*' ? true : env.corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },

    // The Flutter client connects with `setTransports(['websocket'])`, so
    // polling is never used; allowing it anyway costs nothing and keeps a
    // browser behind an awkward proxy able to connect.
    transports: ['websocket', 'polling'],

    // A drawing batch every 60ms means a silent connection is genuinely gone,
    // not merely idle. Detecting that in ~25s rather than the default ~45s
    // gets the reconnect banner up while the player is still looking at it.
    pingInterval: 10_000,
    pingTimeout: 15_000,

    // Strokes are small; a megabyte is already far more than a legitimate
    // batch. The cap stops a client from parking a huge buffer on the server.
    maxHttpBufferSize: 1e6,
  });

  setInstance(server);
  return server;
}

/** The instance, or null before boot. */
export function getSocketServer(): GameServer | null {
  return instance();
}

/** Clears the instance. Used by tests. */
export function resetSocketServer(): void {
  setInstance(null);
}

/** Emits to everyone in a room. */
export function emitToRoom(roomId: string, event: string, payload: unknown): void {
  instance()?.to(roomChannel(roomId)).emit(event, payload);
}

/** Emits to everyone in a room except one socket. */
export function emitToRoomExcept(
  socket: GameSocket,
  roomId: string,
  event: string,
  payload: unknown,
): void {
  socket.to(roomChannel(roomId)).emit(event, payload);
}

/**
 * Emits to one specific socket.
 *
 * Voice chat is the reason this exists. Its mesh is keyed by socket rather
 * than by user — a player signed in twice holds two sockets, and delivering
 * one SDP offer to both would build two half-connections for one person — so
 * signalling has to be addressable at exactly the connection that joined.
 */
export function emitToSocket(socketId: string, event: string, payload: unknown): void {
  instance()?.to(socketId).emit(event, payload);
}

/**
 * Emits to a room's voice group.
 *
 * Distinct from `emitToRoom` on purpose: the drawer is in the room channel and
 * must never receive voice traffic, so this fan-out reaches only the sockets
 * currently admitted to voice.
 */
export function emitToVoice(roomId: string, event: string, payload: unknown): void {
  instance()?.to(voiceChannel(roomId)).emit(event, payload);
}

/** Emits to every socket belonging to one user, across their devices. */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  instance()?.to(userChannel(userId)).emit(event, payload);
}

/**
 * Emits a per-recipient payload to everyone in a room.
 *
 * This is what keeps the answer secret (brief section 21). The drawer's game
 * state carries `word`; everybody else's carries `null`. One broadcast cannot
 * express that, so the room's sockets are walked and each gets a payload built
 * for them. Rooms are at most twelve players, and this runs on phase changes
 * rather than per stroke, so the loop is not a hot path.
 */
export async function emitPerViewer(
  roomId: string,
  event: string,
  build: (viewerId: string) => unknown,
): Promise<void> {
  const server = instance();
  if (!server) return;

  try {
    const sockets = await server.in(roomChannel(roomId)).fetchSockets();
    for (const socket of sockets) {
      const viewerId = socket.data.user?.id;
      if (!viewerId) continue;
      socket.emit(event, build(viewerId));
    }
  } catch (error) {
    logger.exception('per-viewer broadcast failed', error, { roomId, event });
  }
}

/** Disconnects every socket a user holds, after a kick or a ban. */
export async function disconnectUser(userId: string): Promise<void> {
  const server = instance();
  if (!server) return;

  try {
    const sockets = await server.in(userChannel(userId)).fetchSockets();
    for (const socket of sockets) socket.disconnect(true);
  } catch (error) {
    logger.exception('failed to disconnect user sockets', error, { userId });
  }
}

/** Removes every socket a user holds from a room's channel. */
export async function removeUserFromRoomChannel(userId: string, roomId: string): Promise<void> {
  const server = instance();
  if (!server) return;

  try {
    const sockets = await server.in(userChannel(userId)).fetchSockets();
    for (const socket of sockets) {
      socket.leave(roomChannel(roomId));
      socket.data.roomId = null;
    }
  } catch (error) {
    logger.exception('failed to remove user from room channel', error, { userId, roomId });
  }
}

/**
 * Whether this process is holding the sockets.
 *
 * The difference between "nobody is online" and "this process cannot see who
 * is online" matters: in the split deployment the REST process has no server
 * instance at all, and reporting every friend as offline there would be a
 * confident lie. Callers use this to fall back to `lastSeenAt` instead.
 */
export function hasSocketServer(): boolean {
  return instance() !== null;
}

/**
 * Which of [userIds] are connected right now.
 *
 * ## Why the adapter is read directly
 *
 * Every socket joins `userChannel(user.id)` at handshake, so presence is
 * already a fact the adapter holds: a channel with members is a person with a
 * device open. Reading it is a map lookup per id, against `fetchSockets()`
 * which is a round trip per id and returns whole socket objects this only
 * needs the count of.
 *
 * The trade-off is that `adapter.rooms` is process-local. Under a Redis
 * adapter it would report only the sockets attached *here*, so a player
 * connected to another instance would read as offline. That is acceptable for
 * what this drives — a dot beside a name in the invite sheet — and it is why
 * nothing in the invitation rules depends on it: an offline friend can still
 * be invited, and their invitation is waiting when they open the app.
 */
export function onlineUserIds(userIds: string[]): Set<string> {
  const server = instance();
  const online = new Set<string>();
  if (!server) return online;

  for (const userId of userIds) {
    const channel = server.sockets.adapter.rooms.get(userChannel(userId));
    if (channel && channel.size > 0) online.add(userId);
  }

  return online;
}
