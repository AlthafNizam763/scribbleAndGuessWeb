import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { connectToDatabase, databaseStatus, disconnectFromDatabase, watchDatabaseEvents } from '@/config/database';
import { env } from '@/config/env';
import { getSocketServer } from '@/config/socket';
import { metrics } from '@/monitoring/metrics';
import { watchMongoCommands } from '@/monitoring/mongoMonitor';
import { roomService } from '@/services/room.service';
import { attachSocketServer } from '@/socket/socket.server';
import { logger } from '@/utils/logger';

/**
 * The realtime process entry point.
 *
 * ## Why this exists separately from `server.ts`
 *
 * `server.ts` boots Next and Socket.IO on one port, which is the right shape
 * for local development and for any host that runs a long-lived Node process.
 * Vercel is not such a host: it builds the Next app and serves each route
 * handler in `src/app/api` as an isolated serverless function. Nothing there
 * ever executes `server.ts`, so `attachSocketServer` is never called and
 * `/api/health` truthfully reports `socket: detached`. A serverless function
 * also cannot hold a websocket open, so this is not a configuration problem
 * to work around — the runtime simply cannot host Socket.IO.
 *
 * This file is the same realtime server with Next removed, so it can run on a
 * host that keeps a process alive (Render, Railway, Fly, a container). It
 * imports the *existing* handlers — there is no second implementation of
 * anything here.
 *
 * ## Why splitting the two is safe
 *
 * The live room registry in `room.service.ts` is a process-local `Map`, so
 * REST and realtime must not both mutate it from different processes. They
 * do not: the Flutter client uses REST only for guest sign-in, the session
 * and the profile — all stateless and Mongo-backed — and does every stateful
 * thing (room create, join, ready, game, drawing, chat) over the socket. The
 * registry therefore lives entirely in this process, which is exactly the
 * single-owner arrangement it was written for.
 *
 * Both deployments read the same `MONGODB_URI` and sign with the same
 * `JWT_SECRET`, so a token minted by the REST API authenticates here.
 */

/**
 * The realtime server's own health endpoint.
 *
 * `/api/health` on the REST deployment probes this to report the realtime
 * state honestly rather than guessing at it, and a platform health check
 * points here too. Unauthenticated on purpose: a probe carries no
 * credentials, and the counts are operational — how many rooms and players
 * are live, never who they are or what anybody is drawing.
 */
function handleHealth(response: ServerResponse): void {
  const database = databaseStatus();
  const healthy = database === 'connected' && getSocketServer() !== null;

  const rooms = roomService.all();
  const players = rooms.reduce((total, room) => total + room.players.size, 0);

  const body = JSON.stringify({
    success: healthy,
    status: healthy ? 'healthy' : 'degraded',
    service: 'realtime',
    database,
    socket: getSocketServer() ? 'attached' : 'detached',
    rooms: rooms.length,
    players,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });

  response.writeHead(healthy ? 200 : 503, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    // The payload is public and carries no credentials, so a browser-based
    // status page may read it from anywhere.
    'access-control-allow-origin': '*',
  });
  response.end(body);
}

/**
 * The realtime process's metrics (brief section 11).
 *
 * This is the process that matters for a load test — it holds the sockets, the
 * rooms and the boards — so its event-loop delay, socket counts and per-event
 * latencies are the numbers worth reading. The REST deployment serves the same
 * shape from `src/app/api/metrics/route.ts`, describing its own process.
 *
 * Gated by `METRICS_TOKEN` when one is set, exactly as the REST route is. The
 * payload carries no user, room code or word.
 */
function handleMetrics(request: IncomingMessage, response: ServerResponse): void {
  const expected = env.metricsToken.trim();

  if (expected.length > 0) {
    const header = request.headers['x-metrics-token'];
    const bearer = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const presented = (Array.isArray(header) ? header[0] : header) ?? bearer;

    if (!timingSafeEqual(String(presented ?? ''), expected)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Not authorised.' },
        }),
      );
      return;
    }
  }

  response.writeHead(200, {
    'content-type': 'application/json',
    // A cached metric is a wrong metric.
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(metrics.snapshot()));
}

/**
 * Compares two strings without returning early on the first difference.
 *
 * The lengths are folded into the comparison rather than checked first, so a
 * caller cannot learn the token's length by timing a mismatch.
 */
function timingSafeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return difference === 0;
}

/**
 * Everything this process serves over plain HTTP.
 *
 * Socket.IO installs its own listener for `/socket.io/` ahead of this, so by
 * the time a request reaches here it is not a websocket handshake. Only the
 * health endpoints are answered; anything else is a 404, because this is not
 * the REST API and should not look like a broken one.
 */
function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? '/').split('?')[0];

  if (path === '/healthz' || path === '/health' || path === '/api/health' || path === '/') {
    handleHealth(response);
    return;
  }

  if (path === '/metrics' || path === '/api/metrics') {
    handleMetrics(request, response);
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'This is the realtime server. The REST API is deployed separately.',
      },
    }),
  );
}

async function main(): Promise<void> {
  // Connect before listening: a server that accepts sockets it cannot
  // authenticate just turns every handshake into a confusing failure.
  // Event-loop sampling starts before anything else so the boot itself is
  // inside the measurement: a slow start is a signal too.
  metrics.start();
  watchMongoCommands();

  watchDatabaseEvents();
  await connectToDatabase();

  const server = createServer(handleHttp);

  attachSocketServer(server);

  server.listen(env.port, env.host, () => {
    logger.info('realtime server listening', {
      url: `http://${env.host}:${env.port}`,
      env: env.nodeEnv,
      corsOrigins: env.corsOrigins,
    });
  });

  installShutdownHandlers(server);
}

/**
 * Closes the listener, then the database, on a termination signal.
 *
 * Without this a redeploy cuts every live socket mid-round and leaves Mongo
 * connections to time out on their own. `io.close()` disconnects clients
 * deliberately, which gets the reconnect path running on the client rather
 * than leaving it waiting out a ping timeout. The forced exit after ten
 * seconds is the backstop for a connection that will not drain.
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

  process.on('unhandledRejection', (reason) => {
    logger.exception('unhandled promise rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.exception('uncaught exception', error);
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  logger.exception('failed to start the realtime server', error);
  process.exit(1);
});
