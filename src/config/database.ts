import mongoose from 'mongoose';

import { env } from '@/config/env';
import { logger } from '@/utils/logger';

/**
 * The single Mongoose connection, cached across hot reloads.
 *
 * Next.js re-evaluates modules on every edit in development. Without a cache
 * parked on `globalThis`, each reload would open another connection pool and
 * the server would exhaust Mongo's connection limit within a few minutes of
 * editing. The same cache makes `connectToDatabase()` safe to call from every
 * route handler: the first call connects, the rest await the same promise.
 */

interface ConnectionCache {
  connection: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

const globalCache = globalThis as typeof globalThis & {
  __scribbleMongoose?: ConnectionCache;
};

const cache: ConnectionCache = (globalCache.__scribbleMongoose ??= {
  connection: null,
  promise: null,
});

// Reject writes that mention fields the schema does not define, instead of
// silently dropping them. A typo'd field name should be a loud failure.
mongoose.set('strictQuery', true);

/** Mongoose's `readyState` values, named so the checks below read plainly. */
const DISCONNECTED = 0;
const CONNECTED = 1;
const CONNECTING = 2;

/**
 * Opens the connection, or returns the one already open.
 *
 * ## Why the cached instance is re-checked against the driver
 *
 * On a serverless host the process is frozen between invocations rather than
 * torn down, and the TCP socket to Mongo does not survive a long enough sleep.
 * The cached `connection` object is still sitting there when the process
 * thaws, but it is not usable. Returning it on the strength of it being
 * non-null is what made the deployed `/api/health` answer
 * `database: disconnected` on the first request after an idle period, in a few
 * hundred milliseconds — far too fast to have attempted a connection at all.
 *
 * It is worse than a slow health check: `bufferCommands` is off, so a query
 * issued against a dead connection throws immediately instead of waiting for
 * the driver to reconnect. The first player to open the app after a quiet spell
 * would have their guest sign-in fail outright.
 *
 * So the driver's own `readyState` decides, and a cache that no longer matches
 * it is dropped and rebuilt.
 */
export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.connection && mongoose.connection.readyState === CONNECTED) {
    return cache.connection;
  }

  // Anything other than "still connecting" means the cached instance is stale.
  // Clearing it is what forces a genuine reconnect below.
  if (cache.connection && mongoose.connection.readyState !== CONNECTING) {
    logger.warn('mongo connection went stale; reconnecting', {
      readyState: mongoose.connection.readyState,
    });
    cache.connection = null;
    cache.promise = null;
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(env.mongodbUri, {
        // Overrides whatever database the URI's path names. Left unset in the
        // environment it is `undefined`, which the driver ignores.
        dbName: env.mongodbDb,
        // Fail fast rather than queueing commands forever behind a dead
        // server: a request should return a 503 in seconds, not hang.
        serverSelectionTimeoutMS: 8000,
        socketTimeoutMS: 45_000,
        maxPoolSize: 20,
        minPoolSize: 2,
        // Buffering hides connection problems by holding operations until a
        // connection appears. With it off, a query against a down database
        // throws immediately and the error handler reports it honestly.
        bufferCommands: false,
      })
      .then((instance) => {
        logger.info('mongo connected', { database: instance.connection.name });
        return instance;
      })
      .catch((error: unknown) => {
        // Clear the cached promise so the next request retries instead of
        // awaiting a permanently rejected one.
        cache.promise = null;
        logger.exception('mongo connection failed', error);
        throw error;
      });
  }

  cache.connection = await cache.promise;
  return cache.connection;
}

/** Whether the driver currently reports a usable connection. */
export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === CONNECTED;
}

/** A one-word health summary for `GET /api/health`. */
export function databaseStatus(): 'connected' | 'connecting' | 'disconnected' {
  switch (mongoose.connection.readyState) {
    case CONNECTED:
      return 'connected';
    case CONNECTING:
      return 'connecting';
    case DISCONNECTED:
    default:
      return 'disconnected';
  }
}

/** Closes the connection. Used by tests and by graceful shutdown. */
export async function disconnectFromDatabase(): Promise<void> {
  if (!cache.connection) return;
  await mongoose.disconnect();
  cache.connection = null;
  cache.promise = null;
  logger.info('mongo disconnected');
}

/** Attaches connection-level logging once per process. */
export function watchDatabaseEvents(): void {
  const connection = mongoose.connection;
  if (connection.listenerCount('error') > 0) return;

  connection.on('error', (error: unknown) => {
    logger.exception('mongo connection error', error);
  });
  connection.on('disconnected', () => {
    logger.warn('mongo disconnected; the driver will retry');
    cache.connection = null;
    cache.promise = null;
  });
  connection.on('reconnected', () => {
    logger.info('mongo reconnected');
  });
}
