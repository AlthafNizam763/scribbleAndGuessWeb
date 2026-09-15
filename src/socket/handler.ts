import { ZodError } from 'zod';

import { ALIASES, SERVER_ERROR } from '@/constants/socket.constants';
import {
  enforceSocketLimit,
  type RateLimitName,
} from '@/middleware/rateLimit.middleware';
import { roomService } from '@/services/room.service';
import type { Ack, AckFn, GameSocket, RuntimeRoom } from '@/types/socket.types';
import { AppError, ErrorCode } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * The plumbing every socket handler shares.
 *
 * Registering a handler through `on` gives it five things it would otherwise
 * have to repeat: the brief's alias name, rate limiting, payload validation
 * errors turned into acks, unexpected errors logged rather than leaked, and an
 * ack that is always called exactly once.
 *
 * That last one matters more than it looks. The Flutter client's `request()`
 * awaits an ack with an 8-second timeout, so a handler that throws before
 * acking does not produce an error on the client — it produces an eight-second
 * hang and then a timeout, which reads as a broken connection rather than a
 * refused action.
 */

/** Options for one registered handler. */
interface HandlerOptions {
  /** Which rate-limit bucket this action spends from. */
  limit?: RateLimitName;
  /** Whether the caller must already be seated in a room. */
  requiresRoom?: boolean;
  /**
   * A feature-specific event to report failures on, instead of `s:error`.
   *
   * Voice signalling needs this. Its offer, answer and candidate frames are
   * fire-and-forget — a round trip per ICE candidate would slow connection
   * setup for no benefit — so a refusal has nowhere to land, and on `s:error`
   * it would be indistinguishable from any other out-of-band failure. Sending
   * it on `s:voice:error` instead is what lets the client tear its microphone
   * down on `DRAWER_VOICE_DISABLED` without having to guess which subsystem
   * the error came from.
   *
   * The REST-flavoured `ErrorCode` rides along in the payload, because that is
   * the name the brief's security test looks for.
   */
  errorEvent?: string;
}

/** What a handler receives. */
export interface HandlerContext {
  socket: GameSocket;
  userId: string;
  /** The caller's room. Present whenever `requiresRoom` was set. */
  room: RuntimeRoom;
}

type Handler = (
  context: HandlerContext,
  payload: unknown,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

/** Converts a thrown value into the ack envelope the client expects. */
function toAck(error: unknown): Ack {
  if (error instanceof ZodError) {
    return {
      ok: false,
      error: {
        // The client parses this against its own `AppErrorCode`, so the wire
        // spelling is used rather than the REST one.
        code: 'validation',
        message: error.issues[0]?.message ?? 'That request is not valid.',
      },
    };
  }

  if (AppError.isAppError(error)) return { ok: false, error: error.toWirePayload() };

  return {
    ok: false,
    error: { code: 'serverError', message: 'Something went wrong.' },
  };
}

/** Calls an ack at most once, tolerating a client that supplied none. */
function safeAck(ack: unknown, response: Ack): void {
  if (typeof ack !== 'function') return;
  try {
    (ack as AckFn)(response);
  } catch (error) {
    logger.exception('ack callback threw', error);
  }
}

/**
 * Registers one handler under its canonical name and any alias.
 *
 * Socket.IO hands a handler `(...args)`, where the last argument is the ack
 * callback if the client sent one. Both `(payload, ack)` and `(ack)` are
 * possible, so the arguments are inspected rather than assumed.
 */
export function on(
  socket: GameSocket,
  event: string,
  handler: Handler,
  options: HandlerOptions = {},
): void {
  const listener = (...args: unknown[]): void => {
    const last = args[args.length - 1];
    const ack = typeof last === 'function' ? last : undefined;
    const payload = ack ? args[args.length - 2] : last;

    void (async () => {
      try {
        if (options.limit) enforceSocketLimit(socket, options.limit);

        const userId = socket.data.user.id;

        let room: RuntimeRoom | null = null;
        if (options.requiresRoom) {
          const roomId = socket.data.roomId;
          if (!roomId) throw new AppError(ErrorCode.NOT_ROOM_MEMBER, 'You are not in a room.');
          room = roomService.require(roomId);
        }

        const result = await handler(
          { socket, userId, room: room as RuntimeRoom },
          payload ?? {},
        );

        safeAck(ack, { ok: true, ...(result ?? {}) });
      } catch (error) {
        if (!AppError.isAppError(error) && !(error instanceof ZodError)) {
          logger.exception('socket handler failed', error, {
            event,
            userId: socket.data.user?.id,
          });
        }

        const response = toAck(error);
        safeAck(ack, response);

        // A client that sent no ack would otherwise never learn the action
        // failed, so the failure is also pushed out of band.
        if (response.ok) return;

        if (options.errorEvent) {
          socket.emit(options.errorEvent, {
            // The `ErrorCode` name, not the wire code: `DRAWER_VOICE_DISABLED`
            // is what this event exists to be able to say.
            code: AppError.isAppError(error) ? error.code : ErrorCode.VALIDATION_ERROR,
            message: response.error.message,
          });
          return;
        }

        if (!ack) socket.emit(SERVER_ERROR, { error: response.error });
      }
    })();
  };

  socket.on(event, listener);

  // Register the brief's section 16 name too, where one exists.
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (canonical === event) socket.on(alias, listener);
  }
}
