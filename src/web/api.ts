import { apiUrl } from '@/web/env';

/**
 * The REST client.
 *
 * Every HTTP call the web app makes goes through `request`, which exists to
 * make one thing impossible: a failure that reaches the UI as "something went
 * wrong". The API answers in a fixed envelope — `{success, data}` or
 * `{success, error:{code, message}}` — so the real message is always there to
 * be read, and the only reason a client would show a generic string is that it
 * threw the specific one away.
 */

/** What the server puts in the `error` slot of a failed envelope. */
export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * A failed request, carrying everything needed to explain it.
 *
 * `status` is kept alongside the server's own code because the two answer
 * different questions. A 401 with `AUTH_ERROR` means the token is bad; a 401
 * that never reached a route handler has no code at all. Only the status can
 * tell those apart.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /**
   * A sentence a player can act on.
   *
   * The server's own message is preferred whenever there is one — it was
   * written for this exact refusal and says more than the status ever could.
   * The status-derived lines below are the fallback for the cases where no
   * envelope came back: a proxy error page, a gateway timeout, a dead host.
   */
  get friendlyMessage(): string {
    if (this.message && this.code !== 'NETWORK_ERROR') return this.message;

    switch (this.status) {
      case 0:
        return 'Cannot reach the server. Check your connection and that the API URL is correct.';
      case 400:
      case 422:
        return 'Those room settings were not accepted.';
      case 401:
        return 'Your session has expired. Reload the page to sign in again.';
      case 403:
        return 'You are not allowed to do that.';
      case 404:
        return 'That endpoint does not exist on the API.';
      case 409:
        return 'That conflicts with something that already exists.';
      case 429:
        return 'Slow down a moment, then try again.';
      default:
        return this.status >= 500
          ? 'The server had a problem. Try again shortly.'
          : 'That request failed.';
    }
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Bearer token. Omitted for the one unauthenticated route, guest login. */
  token?: string | null;
  signal?: AbortSignal;
}

/**
 * Performs one API call and returns the `data` half of the envelope.
 *
 * A network failure and a rejected request are both thrown as `ApiError`, so
 * callers have a single thing to catch. The distinction survives in `status`:
 * zero means the request never got an answer.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    // fetch rejects for DNS failure, a refused connection, and — the one that
    // actually bites in a browser — a response the CORS layer discarded. The
    // browser deliberately hides which, so the message names all three rather
    // than guessing.
    throw new ApiError(
      'The API did not respond. This is a network, DNS or CORS failure.',
      0,
      'NETWORK_ERROR',
      cause,
    );
  }

  // A 204, or a crash that produced an HTML error page, both leave nothing to
  // parse. Neither should surface as a JSON syntax error.
  const raw = await response.text();
  let envelope: unknown = null;
  if (raw.length > 0) {
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new ApiError(
        `The API returned ${response.status} with a non-JSON body.`,
        response.status,
        'BAD_RESPONSE',
        raw.slice(0, 500),
      );
    }
  }

  const parsed = envelope as
    | { success?: boolean; data?: T; error?: ApiErrorPayload }
    | null;

  if (!response.ok || parsed?.success === false) {
    const error = parsed?.error;
    throw new ApiError(
      error?.message ?? `Request failed with ${response.status}.`,
      response.status,
      error?.code ?? 'HTTP_ERROR',
      error?.details,
    );
  }

  return (parsed?.data ?? null) as T;
}
