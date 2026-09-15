import { io, type Socket } from 'socket.io-client';

import { SOCKET_URL } from '@/web/env';

/**
 * The Socket.IO connection, and the ack protocol on top of it.
 *
 * ## Why room work happens here and not over REST
 *
 * `POST /api/rooms` exists and it creates a real room, but it cannot seat a
 * *socket* — the controller says so itself. A room made that way only gets a
 * live seat on the connection's next `c:hello`, which means the player sits in
 * a lobby that never updates. The Flutter client therefore creates and joins
 * over the socket, where the ack carries the room and the seat is cut in the
 * same operation, and this client does the same.
 *
 * ## The ack envelope
 *
 * Handlers reply `{ok: true, ...payload}` or
 * `{ok: false, error: {code, message}}`. `request` turns the second into a
 * thrown `SocketError`, so a caller writes one happy path and one catch rather
 * than checking a flag on every call.
 *
 * ## The timeout
 *
 * A handler that threw before acking would otherwise hang the caller forever.
 * The server's own `handler.ts` is careful to always ack exactly once, so this
 * is a backstop rather than a routine occurrence — but without it a single
 * server-side bug reads to the player as a frozen button.
 */

/** How long an ack may take before the action is called failed. */
const ACK_TIMEOUT_MS = 10_000;

/** A refused socket action, carrying the server's own error code. */
export class SocketError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SocketError';
    this.code = code;
  }
}

/** Whether to print the connection trace. Off in production builds. */
const DEBUG = process.env.NODE_ENV !== 'production';

/** Development logging. Never given a token, a payload or a word. */
function log(message: string, detail?: unknown): void {
  if (!DEBUG) return;
  if (detail === undefined) console.info(`[Web Socket] ${message}`);
  else console.info(`[Web Socket] ${message}`, detail);
}

let socket: Socket | null = null;
let currentToken: string | null = null;

/**
 * Connects, or returns the live connection.
 *
 * Reconnecting when the token changes matters: the identity is fixed at the
 * handshake, so a socket opened with an old token keeps acting as the old
 * account no matter what the app thinks it is now.
 */
export function connectSocket(token: string): Socket {
  if (socket && currentToken === token) return socket;
  if (socket) disconnectSocket();

  currentToken = token;

  log(`connecting to ${SOCKET_URL || 'same origin'}`);

  socket = io(SOCKET_URL || undefined, {
    // Where the token goes. The server reads `auth.token` first, which is
    // where both this client and `socket_io_client` put it.
    auth: { token },

    // Websocket first, polling kept as a fallback. The Flutter client pins
    // websocket only; a browser behind a proxy that blocks upgrades has no
    // such luxury, and the server allows both.
    transports: ['websocket', 'polling'],

    // The room is authoritative server state, so a dropped connection should
    // climb back into it rather than strand the player.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    timeout: 20_000,
  });

  socket.on('connect', () => log('connected'));
  socket.on('disconnect', (reason) => log('disconnected', reason));
  socket.on('connect_error', (error) => {
    // `AUTH_REQUIRED` and `AUTH_FAILED` arrive here, not on an ack: the
    // handshake middleware rejects before any handler runs.
    log('connect_error', error.message);
  });

  return socket;
}

/** The live connection, or null. */
export function getSocket(): Socket | null {
  return socket;
}

/** Closes the connection and forgets the token it was opened with. */
export function disconnectSocket(): void {
  if (!socket) return;
  log('closing');
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  currentToken = null;
}

/**
 * Emits an event and resolves with the ack payload.
 *
 * Rejects with `SocketError` when the server refuses, and when no ack arrives
 * inside the timeout.
 */
export function request<T = Record<string, unknown>>(
  event: string,
  payload: unknown = {},
): Promise<T> {
  const active = socket;
  if (!active) {
    return Promise.reject(new SocketError('Not connected to the game server.', 'noConnection'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log(`${event} timed out`);
      reject(new SocketError('The server did not respond in time.', 'timeout'));
    }, ACK_TIMEOUT_MS);

    active.emit(event, payload, (ack: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const response = ack as
        | ({ ok: true } & Record<string, unknown>)
        | { ok: false; error?: { code?: string; message?: string } };

      if (!response || typeof response !== 'object') {
        reject(new SocketError('The server sent a reply we could not read.', 'badAck'));
        return;
      }

      if (response.ok !== true) {
        const error = (response as { error?: { code?: string; message?: string } }).error;
        log(`${event} refused`, error?.code);
        reject(new SocketError(error?.message ?? 'That action was refused.', error?.code ?? 'unknown'));
        return;
      }

      resolve(response as T);
    });
  });
}

/** Emits without waiting for an ack. For the fire-and-forget drawing frames. */
export function emit(event: string, payload: unknown = {}): void {
  socket?.emit(event, payload);
}
