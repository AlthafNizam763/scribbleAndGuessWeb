import type { z } from 'zod';

import { errors } from '@/utils/errors';

/**
 * Body and query parsing (brief section 50).
 *
 * Nothing in this codebase reads `await request.json()` directly. Going
 * through here means a malformed body is one predictable error rather than a
 * `SyntaxError` thrown from inside a handler, and every parsed value arrives
 * already typed.
 */

/** Parses and validates a JSON body. */
export async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;

  try {
    const text = await request.text();
    // An empty body is `{}`, so a schema whose fields all have defaults
    // succeeds on a bodyless POST rather than failing on the parse.
    raw = text.trim().length === 0 ? {} : JSON.parse(text);
  } catch {
    throw errors.validation('That request body is not valid JSON.');
  }

  // `parse` throws a ZodError, which the error middleware renders as a
  // VALIDATION_ERROR with per-field detail.
  return schema.parse(raw);
}

/** Parses and validates the query string. */
export function parseQuery<T extends z.ZodTypeAny>(request: Request, schema: T): z.infer<T> {
  const params = new URL(request.url).searchParams;
  return schema.parse(Object.fromEntries(params.entries()));
}

/** Parses a socket payload, which arrives already decoded. */
export function parsePayload<T extends z.ZodTypeAny>(raw: unknown, schema: T): z.infer<T> {
  return schema.parse(raw ?? {});
}
