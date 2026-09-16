import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { metrics } from '@/monitoring/metrics';
import { AppError, ErrorCode, type ErrorPayload } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * The single response format and the single error funnel (brief sections 49
 * and 70).
 *
 * Every route handler is wrapped in `withErrorHandling`, so no handler needs a
 * try/catch and none of them can accidentally return a different shape.
 *
 * ## What a client is told
 *
 * An `AppError` is something the caller can act on — the room is full, they
 * are not the host — so its code and message go out verbatim. Anything else is
 * a bug in this server: it is logged with its stack and reported as a bare
 * `INTERNAL_ERROR`. A Mongo duplicate-key message or a stack trace in a
 * response body tells an attacker about the schema and tells a player nothing.
 */

/** `{ success: true, data }` (brief section 49). */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

/** `{ success: false, error: { code, message } }` (brief section 49). */
export function fail(error: ErrorPayload, status: number): NextResponse {
  return NextResponse.json({ success: false, error }, { status });
}

/** Turns a Zod failure into one readable message plus the field details. */
function fromZod(error: ZodError): { payload: ErrorPayload; status: number } {
  const issues = error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }));

  return {
    status: 422,
    payload: {
      code: ErrorCode.VALIDATION_ERROR,
      message: issues[0]?.message ?? 'That request is not valid.',
      details: issues,
    },
  };
}

/** Maps any thrown value onto a response. */
export function toErrorResponse(error: unknown, context?: Record<string, unknown>): NextResponse {
  if (error instanceof ZodError) {
    const { payload, status } = fromZod(error);
    return fail(payload, status);
  }

  if (AppError.isAppError(error)) {
    // Expected failures are noise at error level; they are normal play.
    if (error.expected) {
      logger.debug('request refused', { ...context, code: error.code });
    } else {
      logger.exception('request failed', error, context);
    }
    return fail(error.toPayload(), error.status);
  }

  // Anything reaching here is unexpected: log everything, reveal nothing.
  logger.exception('unhandled route error', error, context);
  return fail(
    { code: ErrorCode.INTERNAL_ERROR, message: 'Something went wrong.' },
    500,
  );
}

/**
 * Wraps a route handler so every failure becomes the standard error body.
 *
 * Generic over the handler's own arguments so Next.js's `{ params }` second
 * argument survives the wrapping with its type intact.
 */
export function withErrorHandling<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<NextResponse> | NextResponse,
): (request: Request, ...args: Args) => Promise<NextResponse> {
  return async (request: Request, ...args: Args): Promise<NextResponse> => {
    const startedAt = performance.now();
    const path = new URL(request.url).pathname;
    const requestId = readOrMintRequestId(request);

    let response: NextResponse;
    try {
      response = await handler(request, ...args);
    } catch (error) {
      response = toErrorResponse(error, { method: request.method, path, requestId });
    }

    // The route *pattern*, not the path: `/api/rooms/:id` rather than one
    // series per room id. An unbounded metric label is how a metrics system
    // becomes the leak it was installed to find.
    metrics.observeHttp(
      routePattern(path),
      request.method,
      response.status,
      performance.now() - startedAt,
    );

    // Echoed so a client, a log line and a proxy access log can all be lined
    // up against one request when something goes wrong.
    response.headers.set('x-request-id', requestId);
    return response;
  };
}

/**
 * The caller's request id, or a fresh one.
 *
 * Honouring an inbound `x-request-id` is what makes a trace survive a proxy or
 * a client retry: the same identifier appears on every hop rather than a new
 * one per service. It is echoed into logs and back in the response, never used
 * for anything but correlation, and length-capped because it arrives from
 * outside and ends up in a log line.
 */
function readOrMintRequestId(request: Request): string {
  const inbound = request.headers.get('x-request-id')?.trim();
  if (inbound && inbound.length > 0) return inbound.slice(0, 64);
  return randomUUID();
}

/**
 * Collapses a concrete path into the route pattern that produced it.
 *
 * Ids in this app are Mongo ObjectIds, five-character room codes, or numeric
 * turn numbers, so each is recognisable by shape. Anything unrecognised is
 * left alone — a genuinely new path segment should show up as itself once
 * rather than be silently folded into something it is not.
 */
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const ROOM_CODE = /^[A-Z0-9]{5}$/;

export function routePattern(path: string): string {
  const segments = path.split('/').map((segment) => {
    if (OBJECT_ID.test(segment)) return ':id';
    if (ROOM_CODE.test(segment)) return ':code';
    if (/^\d+$/.test(segment)) return ':n';
    return segment;
  });

  return segments.join('/');
}
