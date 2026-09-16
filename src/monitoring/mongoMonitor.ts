import mongoose from 'mongoose';

import { metrics } from '@/monitoring/metrics';
import { logger } from '@/utils/logger';

/**
 * Query timing and slow-query reporting (brief section 4, 11).
 *
 * ## Why the driver's own monitoring rather than a Mongoose plugin
 *
 * A Mongoose middleware hook wraps the *model* call, so it measures Mongoose's
 * work as well as the database's and misses anything issued outside a model —
 * index builds, the connection handshake, `countDocuments` through the raw
 * collection. The driver's command monitoring sits where the wire protocol
 * is, so what it reports is the round trip to Mongo and nothing else, which is
 * the number worth acting on.
 *
 * ## What counts as slow
 *
 * Two hundred milliseconds. Every query this app issues is meant to be an
 * indexed lookup of a handful of small documents, and on a healthy connection
 * those return in single-digit milliseconds. Two hundred is therefore not a
 * tuning target but a smoke alarm — a query that takes that long is almost
 * always a collection scan, which means an index is missing or a filter has
 * stopped matching the index it was written for.
 *
 * ## What is logged
 *
 * The command name and the collection, never the filter. A filter carries user
 * ids, room codes and — through `usedWords` on a room document — words from a
 * live round. A slow-query log that leaks the answer to a game in progress
 * would be a cheating vector sitting in an operational tool the whole team can
 * read, which is the same rule `logger.redact` enforces everywhere else.
 */

/** Past this, a command is reported rather than merely counted. */
const SLOW_COMMAND_MS = 200;

/** Commands that are not application queries and should not be timed. */
const IGNORED_COMMANDS = new Set([
  'ismaster',
  'hello',
  'ping',
  'endSessions',
  'saslStart',
  'saslContinue',
  'authenticate',
  'getnonce',
]);

let installed = false;

/**
 * Attaches command monitoring to the driver.
 *
 * Idempotent, and guarded on a module-level flag rather than by counting
 * listeners: this is called from both entrypoints and, in development, from a
 * module Next.js may re-evaluate on a hot reload. Attaching twice would double
 * every count and eventually trip Node's max-listeners warning.
 */
export function watchMongoCommands(): void {
  if (installed) return;
  installed = true;

  const client = () => mongoose.connection.getClient();

  // The client only exists once `mongoose.connect` has been called, so this is
  // deferred to the connection event rather than run at import time.
  const attach = (): void => {
    let monitored: ReturnType<typeof client>;
    try {
      monitored = client();
    } catch {
      // No client yet. The `connected` handler below will try again.
      return;
    }

    // `monitorCommands` has to have been enabled on the client for these to
    // fire. When it was not, attaching is harmless — the events simply never
    // arrive — so there is nothing to check and nothing to report.
    monitored.on('commandSucceeded', (event) => {
      record(event.commandName, event.duration, null);
    });

    monitored.on('commandFailed', (event) => {
      record(event.commandName, event.duration, event.failure);
      metrics.increment('mongo.commands.failed');
    });
  };

  if (mongoose.connection.readyState === 1) attach();
  mongoose.connection.on('connected', attach);
  mongoose.connection.on('reconnected', attach);
}

function record(commandName: string, durationMs: number, failure: unknown): void {
  if (IGNORED_COMMANDS.has(commandName)) return;

  metrics.observeMongo(commandName, durationMs);

  if (failure) {
    logger.warn('mongo command failed', { command: commandName, durationMs });
    return;
  }

  if (durationMs >= SLOW_COMMAND_MS) {
    metrics.increment('mongo.commands.slow');
    // Command and duration only — never the filter. See the file header.
    logger.warn('slow mongo command', { command: commandName, durationMs });
  }
}

/** Clears the install guard. Used by tests. */
export function resetMongoMonitor(): void {
  installed = false;
}
