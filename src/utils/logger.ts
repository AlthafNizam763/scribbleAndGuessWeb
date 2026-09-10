import { env } from '@/config/env';

/**
 * Structured logging (brief section 69).
 *
 * One line of JSON per event in production so a log shipper can index it, and
 * a readable line in development. Every call takes a short message plus a
 * context object; the context is where identifiers go, never string
 * interpolation, so logs stay greppable by field.
 *
 * ## What must never be logged
 *
 * The secret word of a live round, JWTs, the signing key, and anything that
 * could be replayed as a credential. `redact` below drops those keys even when
 * a caller passes them by accident, because a leaked answer in a log that the
 * whole team can read is a cheating vector, and a leaked token is an account.
 */

type Level = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const threshold = LEVEL_RANK[env.logLevel];

/** Keys whose values are replaced with a marker wherever they appear. */
const SECRET_KEYS = new Set([
  'word',
  'answer',
  'secret',
  'token',
  'idToken',
  'accessToken',
  'jwt',
  'jwtSecret',
  'password',
  'authorization',
  'cookie',
]);

type Context = Record<string, unknown>;

/**
 * Recursively replaces secret values with `[redacted]`.
 *
 * Depth is bounded because a context object could contain a cycle (a Mongoose
 * document, say) and a logger that throws while reporting an error is worse
 * than no logger at all.
 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

function emit(level: Level, message: string, context?: Context): void {
  if (LEVEL_RANK[level] > threshold) return;

  const time = new Date().toISOString();
  const safe = context ? (redact(context) as Context) : undefined;

  if (env.isProduction) {
    // A single JSON line: parseable by every log pipeline, and impossible to
    // split across records by a newline inside a message.
    process.stdout.write(`${JSON.stringify({ time, level, message, ...safe })}\n`);
    return;
  }

  const tail = safe && Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : '';
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${message}${tail}`;
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/**
 * Normalises a thrown value into loggable fields.
 *
 * Stacks are kept out of production output: they are noisy in an aggregator
 * and can echo request data back into the log.
 */
export function describeError(error: unknown): Context {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(env.isProduction ? {} : { stack: error.stack }),
    };
  }
  return { errorMessage: String(error) };
}

export const logger = {
  error(message: string, context?: Context): void {
    emit('error', message, context);
  },
  warn(message: string, context?: Context): void {
    emit('warn', message, context);
  },
  info(message: string, context?: Context): void {
    emit('info', message, context);
  },
  debug(message: string, context?: Context): void {
    emit('debug', message, context);
  },
  /** Logs a caught value at error level with its name, message and stack. */
  exception(message: string, error: unknown, context?: Context): void {
    emit('error', message, { ...context, ...describeError(error) });
  },
};
