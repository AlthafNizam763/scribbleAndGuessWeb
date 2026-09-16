import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Recorder } from './recorder';
import { scenarios, type ScenarioResult } from './scenarios';
import { VirtualUser } from './virtualUser';

/**
 * The load-test runner (brief section 12).
 *
 *   npm run loadtest
 *   npm run loadtest -- --users 100 --api http://localhost:3000 --socket http://localhost:3001
 *
 * ## Why this is a Node script rather than k6
 *
 * k6 runs Go-hosted JavaScript with its own module system and no Node
 * built-ins, so `socket.io-client` — which is what makes these virtual users
 * speak the game's actual protocol rather than a hand-written approximation of
 * it — cannot run inside it. The brief allows "another Node.js-compatible
 * testing tool", and the compatibility that matters here is with the client
 * library the real app uses.
 *
 * ## What it produces
 *
 * A markdown report with the figures section 12 asks for: mean, p95 and p99
 * per operation, error percentages, and the server's own CPU, memory,
 * event-loop delay and Mongo timings read from `/api/metrics` before and
 * after. The correctness checks each scenario makes are listed pass or fail,
 * and any failure makes the process exit non-zero so this can gate a release.
 */

interface Options {
  users: number;
  apiUrl: string;
  socketUrl: string;
  reportPath: string;
  metricsToken: string;
}

function parseArgs(argv: string[]): Options {
  const read = (flag: string, fallback: string): string => {
    const index = argv.indexOf(`--${flag}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
  };

  const socketUrl = read('socket', process.env.LOADTEST_SOCKET_URL ?? 'http://localhost:3000');

  return {
    users: Number(read('users', '100')),
    apiUrl: read('api', process.env.LOADTEST_API_URL ?? 'http://localhost:3000'),
    socketUrl,
    reportPath: read('report', 'docs/LOAD_TEST_RESULTS.md'),
    metricsToken: read('metrics-token', process.env.METRICS_TOKEN ?? ''),
  };
}

/** Reads the server's own metrics, or null when it does not expose them. */
async function readServerMetrics(
  baseUrl: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers['x-metrics-token'] = token;

  for (const path of ['/metrics', '/api/metrics']) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    } catch {
      // Try the next path; report null if neither answers.
    }
  }

  return null;
}

/** Confirms the target is up before a hundred users are pointed at it. */
async function preflight(options: Options): Promise<string | null> {
  try {
    const response = await fetch(`${options.apiUrl}/api/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const body = (await response.json()) as { database?: string; status?: string };

    if (body.database !== 'connected') {
      return `the API reports database: ${body.database ?? 'unknown'}`;
    }
  } catch (error) {
    return `the API at ${options.apiUrl} is not answering (${String(error)})`;
  }

  // The realtime server answers on `/healthz` when it runs standalone, and on
  // `/api/health` when it is the combined `server.ts`. Either is proof it is
  // up; requiring one would make the preflight depend on which deployment
  // shape is being tested.
  for (const path of ['/healthz', '/api/health']) {
    try {
      const response = await fetch(`${options.socketUrl}${path}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) return null;
    } catch {
      // Try the other path.
    }
  }

  return `the realtime server at ${options.socketUrl} is not answering on /healthz or /api/health`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };

  log('');
  log('Scribble & Guess — load test');
  log(`  API       ${options.apiUrl}`);
  log(`  realtime  ${options.socketUrl}`);
  log(`  users     ${options.users}`);
  log('');

  const blocked = await preflight(options);
  if (blocked) {
    log(`Refusing to start: ${blocked}`);
    log('');
    log('Start the servers first:');
    log('  npm run dev          # REST + realtime on one port');
    log('  npm run dev:socket   # realtime only, when running them split');
    process.exit(2);
  }

  const recorder = new Recorder();
  const users = Array.from(
    { length: options.users },
    (_, index) =>
      new VirtualUser({
        apiUrl: options.apiUrl,
        socketUrl: options.socketUrl,
        recorder,
        index,
      }),
  );

  const before = await readServerMetrics(options.socketUrl, options.metricsToken);
  const startedAt = new Date();

  const results: Array<{ scenario: string; id: string; result: ScenarioResult; ms: number }> = [];

  for (const scenario of scenarios) {
    log(`— ${scenario.name}  (case ${scenario.id})`);
    const at = performance.now();

    let result: ScenarioResult;
    try {
      result = await scenario.run({ users, recorder, log: (m) => log(`  ${m}`) });
    } catch (error) {
      // A scenario that throws is itself a finding: the report says so rather
      // than the run dying with a stack trace and no numbers.
      result = {
        checks: [
          {
            label: 'the scenario ran to completion',
            passed: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }

    const ms = performance.now() - at;
    results.push({ scenario: scenario.name, id: scenario.id, result, ms });

    for (const check of result.checks) {
      log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
    }
    log('');
  }

  const after = await readServerMetrics(options.socketUrl, options.metricsToken);

  log('closing every socket');
  for (const user of users) user.disconnect();

  const report = renderReport({
    options,
    startedAt,
    finishedAt: new Date(),
    recorder,
    results,
    before,
    after,
  });

  const path = resolve(process.cwd(), options.reportPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, report, 'utf8');

  const failed = results.flatMap((row) => row.result.checks).filter((check) => !check.passed);

  log('');
  log(`report written to ${options.reportPath}`);
  log(
    failed.length === 0
      ? 'every correctness check passed'
      : `${failed.length} correctness check(s) FAILED`,
  );

  // Let the sockets actually close before the process goes.
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 500).unref();
}

// ------------------------------------------------------------- the report --

interface ReportInput {
  options: Options;
  startedAt: Date;
  finishedAt: Date;
  recorder: Recorder;
  results: Array<{ scenario: string; id: string; result: ScenarioResult; ms: number }>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function renderReport(input: ReportInput): string {
  const { options, recorder, results, before, after } = input;

  const lines: string[] = [];
  const push = (line = ''): void => void lines.push(line);

  const failed = results.flatMap((row) => row.result.checks).filter((check) => !check.passed);

  push('# Load Test Results — Scribble & Guess');
  push();
  push(`Run at ${input.startedAt.toISOString()}, finished ${input.finishedAt.toISOString()}.`);
  push();
  push('| | |');
  push('|---|---|');
  push(`| Virtual users | ${options.users} |`);
  push(`| API | \`${options.apiUrl}\` |`);
  push(`| Realtime | \`${options.socketUrl}\` |`);
  push(
    `| Duration | ${Math.round((input.finishedAt.getTime() - input.startedAt.getTime()) / 1000)}s |`,
  );
  push(`| Correctness checks | ${failed.length === 0 ? '**all passed**' : `**${failed.length} FAILED**`} |`);
  push();

  // ------------------------------------------------------------- scenarios --

  push('## Scenarios');
  push();
  for (const row of input.results) {
    push(`### ${row.scenario}`);
    push();
    push(`Brief section 12, case ${row.id}. Took ${Math.round(row.ms)}ms.`);
    push();
    push('| Check | Result | Detail |');
    push('|---|---|---|');
    for (const check of row.result.checks) {
      push(`| ${check.label} | ${check.passed ? 'PASS' : '**FAIL**'} | ${check.detail ?? ''} |`);
    }
    push();

    const notes = row.result.notes;
    if (notes && Object.keys(notes).length > 0) {
      push('| Figure | Value |');
      push('|---|---|');
      for (const [key, value] of Object.entries(notes)) push(`| ${key} | ${value} |`);
      push();
    }
  }

  // --------------------------------------------------------------- latency --

  push('## Client-observed latency');
  push();
  push('Measured at the virtual user, so these include connection setup, queueing');
  push('and the network — not just server processing time.');
  push();
  push('| Operation | Count | Errors | Error % | Mean | p50 | p95 | p99 | Max |');
  push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');

  for (const [name, summary] of Object.entries(recorder.summaries())) {
    push(
      `| \`${name}\` | ${summary.count} | ${summary.errors} | ${(summary.errorRate * 100).toFixed(2)}% | ` +
        `${summary.meanMs}ms | ${summary.p50Ms}ms | ${summary.p95Ms}ms | ${summary.p99Ms}ms | ${summary.maxMs}ms |`,
    );
  }
  push();

  // ---------------------------------------------------------------- server --

  push('## Server resources');
  push();
  if (!after) {
    push('The realtime server did not expose `/metrics`, so no server-side figures');
    push('were collected. Set `METRICS_TOKEN` to match the server, or check that the');
    push('build includes the metrics endpoint.');
    push();
  } else {
    const process_ = (after.process ?? {}) as Record<string, Record<string, number>>;
    const beforeProcess = ((before?.process ?? {}) as Record<string, Record<string, number>>) ?? {};
    const gauges = (after.gauges ?? {}) as Record<string, Record<string, number>>;
    const counters = (after.counters ?? {}) as Record<string, number>;
    const beforeCounters = ((before?.counters ?? {}) as Record<string, number>) ?? {};

    push('| Metric | Before | After |');
    push('|---|---:|---:|');
    push(
      `| CPU (% of one core) | ${beforeProcess.cpu?.totalPercent ?? '—'} | ${process_.cpu?.totalPercent ?? '—'} |`,
    );
    push(
      `| RSS (MB) | ${beforeProcess.memoryMb?.rss ?? '—'} | ${process_.memoryMb?.rss ?? '—'} |`,
    );
    push(
      `| Heap used (MB) | ${beforeProcess.memoryMb?.heapUsed ?? '—'} | ${process_.memoryMb?.heapUsed ?? '—'} |`,
    );
    push(
      `| Event-loop delay p99 (ms) | ${beforeProcess.eventLoopDelay?.p99Ms ?? '—'} | ${process_.eventLoopDelay?.p99Ms ?? '—'} |`,
    );
    push(
      `| Event-loop delay max (ms) | ${beforeProcess.eventLoopDelay?.maxMs ?? '—'} | ${process_.eventLoopDelay?.maxMs ?? '—'} |`,
    );
    push(
      `| Active handles | ${beforeProcess.activeHandles?.handles ?? '—'} | ${process_.activeHandles?.handles ?? '—'} |`,
    );
    push();

    push('### Realtime gauges at the end of the run');
    push();
    push('| Gauge | Value |');
    push('|---|---:|');
    for (const [key, value] of Object.entries(gauges.realtime ?? {})) push(`| ${key} | ${value} |`);
    push();

    push('### Server counters (delta over the run)');
    push();
    push('| Counter | Delta |');
    push('|---|---:|');
    for (const [key, value] of Object.entries(counters).sort(([a], [b]) => a.localeCompare(b))) {
      push(`| ${key} | ${value - (beforeCounters[key] ?? 0)} |`);
    }
    push();

    const mongo = (after.mongo ?? {}) as Record<string, { count: number; p95Ms: number; p99Ms: number; maxMs: number }>;
    if (Object.keys(mongo).length > 0) {
      push('### MongoDB command latency');
      push();
      push('| Command | Count | p95 | p99 | Max |');
      push('|---|---:|---:|---:|---:|');
      for (const [command, summary] of Object.entries(mongo)) {
        push(`| ${command} | ${summary.count} | ${summary.p95Ms}ms | ${summary.p99Ms}ms | ${summary.maxMs}ms |`);
      }
      push();
      push(`Slow commands (over 200ms): **${counters['mongo.commands.slow'] ?? 0}**`);
      push();
    }

    const socket = (after.socket ?? {}) as Record<string, { count: number; p95Ms: number; p99Ms: number }>;
    if (Object.keys(socket).length > 0) {
      push('### Socket handler latency (server-side)');
      push();
      push('| Event | Count | p95 | p99 |');
      push('|---|---:|---:|---:|');
      for (const [event, summary] of Object.entries(socket).sort(
        ([, a], [, b]) => b.count - a.count,
      )) {
        push(`| \`${event}\` | ${summary.count} | ${summary.p95Ms}ms | ${summary.p99Ms}ms |`);
      }
      push();
    }
  }

  // -------------------------------------------------------------- failures --

  const failures = recorder.failures();
  if (failures.length > 0) {
    push('## Failures observed');
    push();
    push('Refusals the server deliberately sent — room full, rate limited — appear');
    push('here too. A scenario that expects them says so in its checks above.');
    push();
    push('| Operation | Reason | Count |');
    push('|---|---|---:|');
    for (const row of failures.slice(0, 40)) {
      push(`| \`${row.operation}\` | ${row.reason.replace(/\|/g, '\\|')} | ${row.count} |`);
    }
    push();
  }

  push('## Crash count');
  push();
  const restarts = after
    ? Number((after as { uptimeSeconds?: number }).uptimeSeconds ?? 0) <
      Number((before as { uptimeSeconds?: number } | null)?.uptimeSeconds ?? 0)
    : null;
  push(
    restarts === null
      ? 'Not determinable: the server did not expose metrics.'
      : restarts
        ? '**The server restarted during the run** — its uptime went backwards.'
        : 'None. The server\'s uptime increased monotonically across the run, so the process never restarted.',
  );
  push();

  return lines.join('\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`load test failed: ${String(error)}\n`);
  process.exit(1);
});
