import { NextResponse, type NextRequest } from 'next/server';

/**
 * CORS for the REST API.
 *
 * `CORS_ORIGIN` was only ever read by the Socket.IO server (`config/socket.ts`);
 * route handlers never saw it, so their responses carried no
 * `Access-Control-Allow-Origin`. Native clients send no `Origin` header and are
 * unaffected by that, which is why it went unnoticed until the Flutter *web*
 * build called the same routes from a browser: Chrome discarded every reply and
 * the app reported it as "No connection".
 *
 * `process.env` is read directly rather than importing `@/config/env`, because
 * middleware runs in the Edge runtime where that module's `dotenv` loading —
 * which needs `fs` — is not available.
 */

const CONFIGURED = (process.env.CORS_ORIGIN ?? '*').trim();

/** `null` means "any origin"; otherwise the explicit allowlist. */
const ALLOWLIST =
  CONFIGURED === '*'
    ? null
    : CONFIGURED.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);

function allowedOrigin(origin: string | null): string | null {
  if (ALLOWLIST === null) return '*';
  return origin !== null && ALLOWLIST.includes(origin) ? origin : null;
}

function applyCors(response: NextResponse, origin: string | null): NextResponse {
  const allowed = allowedOrigin(origin);
  // A disallowed origin gets the response without the header, which is what
  // makes the browser reject it. Answering 403 here would be worse: it would
  // report a permission problem to non-browser callers that have none.
  if (allowed === null) return response;

  response.headers.set('Access-Control-Allow-Origin', allowed);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.headers.set('Access-Control-Max-Age', '86400');

  // Once the header depends on the request's Origin, the reply is no longer
  // cacheable as one shared answer.
  if (allowed !== '*') response.headers.append('Vary', 'Origin');

  return response;
}

export function middleware(request: NextRequest): NextResponse {
  const origin = request.headers.get('origin');

  // Preflight never reaches a route handler; answer it here.
  if (request.method === 'OPTIONS') {
    return applyCors(new NextResponse(null, { status: 204 }), origin);
  }

  return applyCors(NextResponse.next(), origin);
}

export const config = { matcher: '/api/:path*' };
