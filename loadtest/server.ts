import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';

import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Boots an isolated stack for the load run: a real MongoDB and the real
 * servers, on a throwaway database.
 *
 *   npm run loadtest:stack
 *
 * ## Why a real mongod rather than the configured Atlas cluster
 *
 * Two reasons, and the second is the important one.
 *
 * The obvious one is safety: a hundred virtual users create a hundred guest
 * accounts, a dozen rooms, and every notification and XP row those produce.
 * None of that belongs in a database holding real players.
 *
 * The one that actually decides the result is that a load test against a
 * remote cluster measures the *link* to that cluster. Every query would carry
 * tens of milliseconds of round trip that has nothing to do with this code,
 * and on a shared tier the throughput ceiling is the tier's, not the server's.
 * The report would then say the app is slow when what is slow is the distance
 * to Atlas — and worse, it would hide a genuine regression underneath that
 * noise. `mongodb-memory-server` runs an ordinary mongod on loopback, so what
 * is left in the measurement is the server.
 *
 * It is a real MongoDB, not a stub: the same wire protocol, the same query
 * planner, the same index behaviour. Only the storage is ephemeral.
 *
 * ## What this does not simulate
 *
 * Disk contention, replica-set write concern, and the latency of a cluster
 * under someone else's load. Those are properties of a deployment rather than
 * of this code, and the right place to measure them is a staging environment
 * that mirrors production. What this run answers is narrower and is the
 * question the brief asks: does the server hold up under a hundred concurrent
 * users, and where does its own time go.
 */

const REALTIME_PORT = Number(process.env.LOADTEST_PORT ?? 3210);

let mongo: MongoMemoryServer | null = null;
let realtime: ChildProcess | null = null;

/** Waits until a URL answers, or gives up. */
async function waitForHealthy(url: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

/** A port nothing else is on, so parallel runs do not collide. */
async function freePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(preferred, () => {
      probe.close(() => resolve(preferred));
    });
    probe.on('error', () => resolve(0));
  });
}

async function main(): Promise<void> {
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };

  log('starting an ephemeral mongod…');
  mongo = await MongoMemoryServer.create({
    instance: { dbName: 'scribbleAndGuess_loadtest' },
  });
  const uri = mongo.getUri();
  log(`  mongod listening (database: scribbleAndGuess_loadtest)`);

  const port = (await freePort(REALTIME_PORT)) || REALTIME_PORT + 1;

  // `dist/server.js`, not `socket-server.ts`: the load suite exercises REST
  // and sockets together, and `server.ts` is the entrypoint that serves both
  // on one port. Running the *built* output rather than `tsx server.ts` also
  // matters for the numbers — Next's dev server compiles each route on first
  // request, so a dev run would report several seconds for whichever virtual
  // user happened to touch a route first and attribute it to the server.
  log(`starting the built server on :${port}…`);
  realtime = spawn(process.execPath, ['dist/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MONGODB_URI: uri,
      MONGODB_DB: 'scribbleAndGuess_loadtest',
      PORT: String(port),
      HOST: '127.0.0.1',
      // Quiet: the run's own output is the interesting stream, and `info` logs
      // a line per room created, which at a hundred users is noise.
      LOG_LEVEL: 'warn',
      // A known secret so the run is reproducible and nothing reaches for a
      // real one.
      JWT_SECRET: 'loadtest-secret-not-used-anywhere-else-0123456789',
      CORS_ORIGIN: '*',
      METRICS_TOKEN: '',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  realtime.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      log(`server exited unexpectedly: code ${code} signal ${signal}`);
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  if (!(await waitForHealthy(`${baseUrl}/api/health`))) {
    log('the server never became healthy');
    await shutdown(1);
    return;
  }

  log(`  healthy at ${baseUrl}`);
  log('');

  if (process.argv.includes('--run')) {
    // One command for the whole thing: stack up, suite through, stack down.
    log('running the load suite against it…');
    log('');

    const suite = spawn(
      process.execPath,
      ['--import', 'tsx', 'loadtest/run.ts', ...process.argv.slice(2).filter((a) => a !== '--run'), '--api', baseUrl, '--socket', baseUrl],
      { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'inherit', 'inherit'] },
    );

    suite.on('exit', (code) => void shutdown(code ?? 1));
    return;
  }

  log('stack ready. In another terminal:');
  log('');
  log(`  npm run loadtest -- --api ${baseUrl} --socket ${baseUrl}`);
  log('');
  log('Ctrl+C to tear the stack down.');

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
}

async function shutdown(code: number): Promise<void> {
  realtime?.kill('SIGTERM');
  await mongo?.stop();
  process.exit(code);
}

main().catch((error: unknown) => {
  process.stderr.write(`stack failed to start: ${String(error)}\n`);
  void shutdown(1);
});
