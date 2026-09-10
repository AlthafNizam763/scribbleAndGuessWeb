import { NextResponse } from 'next/server';

import { connectToDatabase, databaseStatus } from '@/config/database';
import { env } from '@/config/env';
import { getSocketServer } from '@/config/socket';
import { withErrorHandling } from '@/middleware/error.middleware';
import { roomService } from '@/services/room.service';

/**
 * `GET /api/health` (brief section 54).
 *
 * Deliberately unauthenticated: a load balancer's probe has no credentials,
 * and a health check that can fail on auth is a health check that reports the
 * wrong thing.
 *
 * It reports 503 rather than 200 when the database is unreachable, so an
 * orchestrator actually takes the instance out of rotation instead of sending
 * it traffic it cannot serve.
 *
 * The counts are operational, not sensitive: how many rooms and players are
 * live, never who they are or what anybody is drawing.
 *
 * ## Why the socket field is a probe rather than a flag
 *
 * This route can run in two very different places.
 *
 * Under `server.ts` it shares a process with the realtime server, so
 * `getSocketServer()` answers truthfully and the report says `attached`.
 *
 * On a serverless host it does not. Vercel builds the Next app and serves
 * this file as an isolated function; nothing there executes `server.ts`, so
 * `attachSocketServer` is never called and the in-process check can only ever
 * say `detached` — which is exactly what it used to report. Reporting
 * `connected` from here would be a lie, and reporting `external` on the
 * strength of an environment variable being set would be a guess.
 *
 * So when the realtime server is deployed separately this asks it. The answer
 * is whatever `SOCKET_URL/healthz` actually said, cached briefly so a busy
 * probe does not turn into a stampede against the realtime host.
 */

interface SocketReport {
  mode: 'attached' | 'external' | 'not_configured';
  status: 'up' | 'down' | 'unknown';
  url?: string;
  rooms?: number;
  players?: number;
  reason?: string;
  checkedAt?: string;
}

/**
 * The last probe result, held for a few seconds.
 *
 * A health endpoint is polled, and every poll would otherwise mean a second
 * network round trip to the realtime host. The window is short enough that a
 * realtime server going down is still noticed promptly.
 */
const PROBE_TTL_MS = 10_000;
const PROBE_TIMEOUT_MS = 4000;

const globalProbe = globalThis as typeof globalThis & {
  __scribbleSocketProbe?: { at: number; report: SocketReport };
};

/** Asks the realtime deployment how it is doing. */
async function probeRealtime(url: string): Promise<SocketReport> {
  const base = url.replace(/\/+$/, '');
  const target = `${base}/healthz`;

  try {
    const response = await fetch(target, {
      // A probe must never read a cached answer: the whole point is the
      // current state.
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        mode: 'external',
        status: 'down',
        url: base,
        reason: `realtime health returned HTTP ${response.status}`,
        checkedAt: new Date().toISOString(),
      };
    }

    const body = (await response.json()) as {
      socket?: string;
      rooms?: number;
      players?: number;
    };

    const attached = body.socket === 'attached';

    return {
      mode: 'external',
      status: attached ? 'up' : 'down',
      url: base,
      rooms: body.rooms,
      players: body.players,
      ...(attached ? {} : { reason: 'realtime server reachable but socket not attached' }),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    // A timeout, DNS failure or refused connection all mean the same thing to
    // a caller: the realtime server is not answering.
    return {
      mode: 'external',
      status: 'down',
      url: base,
      reason: error instanceof Error ? error.message : 'realtime server unreachable',
      checkedAt: new Date().toISOString(),
    };
  }
}

/** Builds the socket half of the report. */
async function socketReport(): Promise<SocketReport> {
  // Same process as the realtime server (`server.ts`, and local development).
  const inProcess = getSocketServer();
  if (inProcess) {
    const rooms = roomService.all();
    return {
      mode: 'attached',
      status: 'up',
      rooms: rooms.length,
      players: rooms.reduce((total, room) => total + room.players.size, 0),
    };
  }

  const configured = env.socketUrl.trim();
  if (!configured) {
    return {
      mode: 'not_configured',
      status: 'unknown',
      reason: 'SOCKET_URL is not set, and no realtime server is attached to this process',
    };
  }

  const cached = globalProbe.__scribbleSocketProbe;
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.report;

  const report = await probeRealtime(configured);
  globalProbe.__scribbleSocketProbe = { at: Date.now(), report };
  return report;
}

export const GET = withErrorHandling(async () => {
  // Attempt a connection so a probe against a cold instance reports the state
  // it would be in for a real request, rather than a permanent "disconnected".
  await connectToDatabase().catch(() => undefined);

  const database = databaseStatus();
  const socket = await socketReport();

  // The database decides whether this instance can serve requests at all, so
  // it alone decides the status code — a realtime outage must not pull the
  // REST API out of rotation, because guest sign-in still works without it.
  // The overall status still degrades, so the outage is visible.
  const databaseHealthy = database === 'connected';
  const status = !databaseHealthy ? 'degraded' : socket.status === 'up' ? 'healthy' : 'degraded';

  return NextResponse.json(
    {
      success: databaseHealthy,
      status,
      database,
      socket,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    { status: databaseHealthy ? 200 : 503 },
  );
});

export const dynamic = 'force-dynamic';
