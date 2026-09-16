import { createServer } from 'node:http';
import { parse } from 'node:url';

import next from 'next';

import { connectToDatabase, disconnectFromDatabase, watchDatabaseEvents } from '@/config/database';
import { env } from '@/config/env';
import { getSocketServer } from '@/config/socket';
import { metrics } from '@/monitoring/metrics';
import { watchMongoCommands } from '@/monitoring/mongoMonitor';
import { attachSocketServer } from '@/socket/socket.server';
import { logger } from '@/utils/logger';

/**
 * The process entry point.
 *
 * ## Why a custom server rather than `next start`
 *
 * Socket.IO needs a live HTTP server to attach its upgrade handler to, and
 * Next's own server does not expose one. Booting Next as a request handler
 * inside a server we create gives both on a single port: REST routes are
 * served by Next, websockets by Socket.IO, and a deployment forwards one
 * origin instead of two.
 *
 * It also means the in-memory room registry is shared by both. A REST call
 * that creates a room and a socket that joins it are looking at the same
 * `Map`, which is what makes the REST API and the realtime layer describe one
 * game rather than two.
 */

const app = next({ dev: !env.isProduction, hostname: env.host, port: env.port });
const handle = app.getRequestHandler();

async function main(): Promise<void> {
  await app.prepare();

  // Connect before listening: a server that accepts requests it cannot serve
  // just turns every early call into a confusing 500.
  // Event-loop sampling starts before anything else so the boot itself is
  // inside the measurement: a slow start is a signal too.
  metrics.start();
  watchMongoCommands();

  watchDatabaseEvents();
  await connectToDatabase();

  const server = createServer((request, response) => {
    // Socket.IO installs its own listener for its path; everything else is
    // Next's.
    void handle(request, response, parse(request.url ?? '', true));
  });

  attachSocketServer(server);

  // `env.host` defaults to 0.0.0.0 and `env.port` comes from PORT, which is
  // what a platform like Render requires: it injects the port and routes to
  // the container's external interface, so binding 127.0.0.1 or a hardcoded
  // 3000 would fail its health check and never receive traffic.
  server.listen(env.port, env.host, () => {
    logger.info('server listening', {
      url: `http://${env.host}:${env.port}`,
      env: env.nodeEnv,
      socketPath: '/socket.io',
      corsOrigins: env.corsOrigins,
    });
  });

  installShutdownHandlers(server);
}

/**
 * Closes the listener, then the database, on a termination signal.
 *
 * Without this a redeploy cuts every live socket mid-round and leaves Mongo
 * connections to time out on their own. The forced exit after ten seconds is
 * the backstop for a connection that will not drain.
 */
function installShutdownHandlers(server: ReturnType<typeof createServer>): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('shutting down', { signal });

    const forced = setTimeout(() => {
      logger.warn('forcing exit after a shutdown timeout');
      process.exit(1);
    }, 10_000);
    forced.unref();

    // Disconnect clients deliberately rather than letting them wait out a ping
    // timeout: that gets the Flutter client's reconnect path running straight
    // away instead of leaving a round looking frozen. It also releases the
    // upgrade listener, without which `server.close()` waits on live sockets
    // and the platform's shutdown grace period expires into a SIGKILL.
    getSocketServer()?.close();

    server.close(() => {
      void disconnectFromDatabase()
        .catch((error: unknown) => {
          logger.exception('failed to close the database cleanly', error);
        })
        .finally(() => {
          clearTimeout(forced);
          process.exit(0);
        });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A rejection nobody handled is a bug. Log it loudly rather than letting
  // Node's default behaviour take the process down without explanation.
  process.on('unhandledRejection', (reason) => {
    logger.exception('unhandled promise rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.exception('uncaught exception', error);
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  logger.exception('failed to start the server', error);
  process.exit(1);
});
