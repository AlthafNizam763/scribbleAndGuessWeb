import { NextResponse } from 'next/server';

import { connectToDatabase, databaseStatus } from '@/config/database';
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
 */
export const GET = withErrorHandling(async () => {
  // Attempt a connection so a probe against a cold instance reports the state
  // it would be in for a real request, rather than a permanent "disconnected".
  await connectToDatabase().catch(() => undefined);

  const database = databaseStatus();
  const healthy = database === 'connected';

  const rooms = roomService.all();
  const players = rooms.reduce((total, room) => total + room.players.size, 0);

  return NextResponse.json(
    {
      success: healthy,
      status: healthy ? 'healthy' : 'degraded',
      database,
      socket: getSocketServer() ? 'attached' : 'detached',
      rooms: rooms.length,
      players,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
});

export const dynamic = 'force-dynamic';
