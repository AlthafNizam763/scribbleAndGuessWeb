import { NextResponse } from 'next/server';

import { env } from '@/config/env';
import { withErrorHandling } from '@/middleware/error.middleware';
import { metrics } from '@/monitoring/metrics';

/**
 * `GET /api/metrics` (brief section 11).
 *
 * CPU, memory, event-loop delay, socket and room counts, request and socket
 * latency percentiles, error counts and Mongo command timings, as one JSON
 * document.
 *
 * ## Why it can be read without credentials, and when it cannot
 *
 * The payload is deliberately free of anything identifying: counts, durations,
 * and labels that are route patterns and socket event names. A route pattern
 * is `/api/rooms/:id`, never a real room id. So there is nothing here to leak
 * to somebody who reads it.
 *
 * What it *does* describe is the shape of the deployment — how loaded it is,
 * how many people are on it — which is operational intelligence rather than
 * user data but is still not everybody's business. So a deployment can require
 * a token by setting `METRICS_TOKEN`, and when it does, this refuses without
 * it. Left unset the endpoint is open, which is the right default for a probe
 * on a private network and for reading numbers during a load test.
 *
 * The comparison is length-safe rather than a plain `===` for the usual
 * reason: a short-circuiting string compare leaks the token's prefix to
 * somebody willing to time enough requests.
 *
 * ## Why this returns 200 even when the process is unhealthy
 *
 * `/api/health` is the endpoint that says whether to route traffic here, and
 * it returns 503 when the database is down. This one reports *numbers*, and
 * the numbers are most wanted precisely when something is wrong — a metrics
 * endpoint that starts failing during an incident is a metrics endpoint that
 * is useless during an incident.
 */

export const GET = withErrorHandling(async (request: Request) => {
  const expected = env.metricsToken.trim();

  if (expected.length > 0) {
    const presented =
      request.headers.get('x-metrics-token') ??
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
      '';

    if (!timingSafeEqual(presented, expected)) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Not authorised.' } },
        { status: 401 },
      );
    }
  }

  return NextResponse.json(metrics.snapshot(), {
    status: 200,
    // A cached metric is a wrong metric.
    headers: { 'cache-control': 'no-store' },
  });
});

/**
 * Compares two strings without returning early on the first difference.
 *
 * `node:crypto`'s own `timingSafeEqual` throws when the buffers differ in
 * length, which would itself leak the token's length, so the lengths are
 * folded into the same constant-time comparison instead of being checked
 * first.
 */
function timingSafeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return difference === 0;
}

export const dynamic = 'force-dynamic';
