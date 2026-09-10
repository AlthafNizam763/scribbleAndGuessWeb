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

/** Opens the connection, or returns the one already open. */
export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.connection) return cache.connection;

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
  return mongoose.connection.readyState === 1;
}

/** A one-word health summary for `GET /api/health`. */
export function databaseStatus(): 'connected' | 'connecting' | 'disconnected' {
  switch (mongoose.connection.readyState) {
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
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
