/**
 * The web client's view of where the backend lives.
 *
 * This is the only file that names a host. Everything else — the REST client,
 * the socket client — asks here, so there is exactly one place to change when
 * a deployment moves and no chance of half the app talking to one origin and
 * half to another.
 *
 * ## Why the defaults are empty strings
 *
 * An empty base means "same origin": the browser resolves `/api/rooms` against
 * whatever host served the page. That is the correct default here because this
 * client is served by the same Next app that owns the REST routes, so the
 * common case needs no configuration and produces no cross-origin request at
 * all — which means no CORS preflight and no way to point the two halves at
 * different deployments by accident.
 *
 * The variables exist for the split deployment: REST on Vercel, Socket.IO on
 * Render. Set them there and the client reaches across; leave them unset in
 * development and it stays local.
 *
 * ## These are read at build time
 *
 * `NEXT_PUBLIC_*` values are inlined by the compiler, not read at runtime.
 * Changing one in a hosting dashboard does nothing until the app is rebuilt
 * and redeployed.
 */

/** Trims a trailing slash so joins never produce `//api/rooms`. */
function normalize(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Base for every REST call. Empty means same origin.
 *
 * `NEXT_PUBLIC_API_URL` is accepted as a fallback because the server-side
 * config schema in `@/config/env` already defines that name, and having the
 * two disagree would be its own bug.
 */
export const API_BASE_URL = normalize(
  process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_URL,
);

/**
 * Where the Socket.IO server is.
 *
 * Note what is *not* here: a `/socket.io` suffix. That path is the client
 * library's own default and it appends it itself; putting it in the origin
 * would make it ask for `/socket.io/socket.io/` and fail the handshake.
 */
export const SOCKET_URL = normalize(process.env.NEXT_PUBLIC_SOCKET_URL);

/** Joins the API base to a path that already starts with `/`. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
