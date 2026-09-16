import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/**
 * Process and application metrics (brief section 11).
 *
 * ## Why this is hand-rolled rather than `prom-client`
 *
 * What a hundred-player deployment needs is a handful of numbers on one JSON
 * endpoint that a person can read during a load test and a probe can scrape
 * afterwards. That is a few hundred lines with no dependency, no exposition
 * format to get right, and no second vocabulary — the names here are the names
 * the rest of this codebase already uses. If a Prometheus scrape is wanted
 * later, `snapshot()` is the one function that has to grow a second renderer.
 *
 * ## What is deliberately *not* here
 *
 * Anything identifying. A metric is a count or a duration, labelled by route
 * or by event name, never by user, room code or address. This endpoint is
 * operational data and is written on the assumption it may be read by anybody
 * who can reach it.
 *
 * ## Memory
 *
 * Every structure here is bounded. Histograms keep a fixed reservoir of recent
 * samples rather than every sample, counters are a map with a ceiling on
 * distinct keys, and the event-loop histogram is Node's own, which is a fixed
 * allocation. A metrics system that leaks is worse than no metrics system,
 * because it fails exactly when it is being used to diagnose a leak.
 */

/** How many recent samples a histogram keeps for percentile estimation. */
const RESERVOIR_SIZE = 1024;

/** The most distinct label values any one metric will track. */
const MAX_SERIES = 200;

/**
 * A duration distribution over a bounded window of recent samples.
 *
 * ## Why a ring buffer rather than every sample or a fixed bucket layout
 *
 * Keeping every sample is a leak. Fixed buckets need their boundaries chosen
 * up front, and a boundary set for an API that answers in 20ms tells you
 * nothing once it starts answering in 2s — which is precisely the moment the
 * number matters. A ring of the last thousand samples costs 8KB, always
 * describes recent behaviour rather than an average since boot, and sorts in
 * microseconds when a percentile is actually asked for.
 *
 * `count`, `sum` and `max` are kept since boot separately, because those three
 * *should* be cumulative: a spike an hour ago should still be visible in `max`
 * even though it has long rotated out of the ring.
 */
export class Histogram {
  private readonly samples = new Float64Array(RESERVOIR_SIZE);
  private cursor = 0;
  private filled = 0;

  count = 0;
  sum = 0;
  max = 0;

  observe(valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;

    this.samples[this.cursor] = valueMs;
    this.cursor = (this.cursor + 1) % RESERVOIR_SIZE;
    if (this.filled < RESERVOIR_SIZE) this.filled += 1;

    this.count += 1;
    this.sum += valueMs;
    if (valueMs > this.max) this.max = valueMs;
  }

  /** Mean, percentiles and totals. Percentiles describe the recent window. */
  summary(): {
    count: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  } {
    if (this.count === 0) {
      return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
    }

    const window = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);

    const at = (fraction: number): number => {
      if (window.length === 0) return 0;
      const index = Math.min(window.length - 1, Math.floor(fraction * window.length));
      return round(window[index] ?? 0);
    };

    return {
      count: this.count,
      meanMs: round(this.sum / this.count),
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      p99Ms: at(0.99),
      maxMs: round(this.max),
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * A family of histograms keyed by label — a route, a socket event name.
 *
 * The key count is capped. An unbounded label is the classic way a metrics
 * system becomes the memory leak it was installed to find, and the labels here
 * come from route paths and event names, which a misbehaving client can
 * influence. Past the cap everything lands in `other` rather than being
 * dropped, so the totals stay honest even when the breakdown stops growing.
 */
class LabelledHistograms {
  private readonly series = new Map<string, Histogram>();

  observe(label: string, valueMs: number): void {
    let histogram = this.series.get(label);

    if (!histogram) {
      if (this.series.size >= MAX_SERIES) {
        histogram = this.series.get('other');
        if (!histogram) {
          histogram = new Histogram();
          this.series.set('other', histogram);
        }
      } else {
        histogram = new Histogram();
        this.series.set(label, histogram);
      }
    }

    histogram.observe(valueMs);
  }

  snapshot(): Record<string, ReturnType<Histogram['summary']>> {
    const out: Record<string, ReturnType<Histogram['summary']>> = {};
    for (const [label, histogram] of this.series) out[label] = histogram.summary();
    return out;
  }

  reset(): void {
    this.series.clear();
  }
}

/** Monotonic counters, keyed by name. Same ceiling, same reason. */
class Counters {
  private readonly values = new Map<string, number>();

  increment(name: string, by = 1): void {
    if (!this.values.has(name) && this.values.size >= MAX_SERIES) {
      this.values.set('other', (this.values.get('other') ?? 0) + by);
      return;
    }
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  reset(): void {
    this.values.clear();
  }
}

/**
 * Event-loop delay, measured by Node itself.
 *
 * ## Why this is the single most important number here
 *
 * This process is single-threaded and does everything: relays strokes, runs
 * the game engine, awaits Mongo, serialises state. When it gets slow, *every*
 * one of those gets slow together, and the symptom players report is "the
 * game froze" regardless of which one is at fault. Event-loop delay is the
 * direct measurement of that — it is how long a callback that was ready to run
 * had to wait — so it is the number that says whether the server is genuinely
 * saturated or merely waiting on something external.
 *
 * `monitorEventLoopDelay` samples in the libuv layer rather than by scheduling
 * a timer and timing it, so measuring costs essentially nothing and the
 * measurement is not itself delayed by the thing it is measuring.
 */
class EventLoopMonitor {
  private histogram: IntervalHistogram | null = null;

  start(): void {
    if (this.histogram) return;
    this.histogram = monitorEventLoopDelay({ resolution: 10 });
    this.histogram.enable();
  }

  /** Delay in milliseconds. Node reports nanoseconds. */
  snapshot(): { meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number } {
    const histogram = this.histogram;
    if (!histogram) return { meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };

    const ms = (nanoseconds: number): number =>
      Number.isFinite(nanoseconds) ? round(nanoseconds / 1e6) : 0;

    return {
      meanMs: ms(histogram.mean),
      p50Ms: ms(histogram.percentile(50)),
      p95Ms: ms(histogram.percentile(95)),
      p99Ms: ms(histogram.percentile(99)),
      maxMs: ms(histogram.max),
    };
  }

  /**
   * Clears the accumulated distribution.
   *
   * Called after each snapshot is read by a scrape would make every reading
   * describe the interval since the last one. It is *not* called there, on
   * purpose — two scrapers would then steal each other's data. Tests use it.
   */
  reset(): void {
    this.histogram?.reset();
  }
}

/**
 * CPU usage as a fraction of one core, measured between reads.
 *
 * `process.cpuUsage()` is cumulative microseconds since boot, which on its own
 * says nothing about now. The useful figure is the delta over the wall-clock
 * time that elapsed alongside it, so the previous reading is kept and the
 * ratio reported. The first read after boot therefore describes the whole
 * uptime, which is the honest answer when there is nothing to compare against.
 */
class CpuMeter {
  private lastUsage = process.cpuUsage();
  private lastAt = Date.now();

  read(): { userPercent: number; systemPercent: number; totalPercent: number } {
    const now = Date.now();
    const usage = process.cpuUsage(this.lastUsage);

    const elapsedMs = Math.max(1, now - this.lastAt);
    this.lastUsage = process.cpuUsage();
    this.lastAt = now;

    // cpuUsage is microseconds; elapsed is milliseconds.
    const toPercent = (micros: number): number => round((micros / 1000 / elapsedMs) * 100);

    const userPercent = toPercent(usage.user);
    const systemPercent = toPercent(usage.system);

    return {
      userPercent,
      systemPercent,
      totalPercent: round(userPercent + systemPercent),
    };
  }
}

/**
 * Live gauges the metrics module cannot compute for itself.
 *
 * Socket and room counts live in the socket server and the room registry, and
 * importing either from here would build a cycle — the socket layer reports
 * *into* this module. So the owner registers a reader instead, and a process
 * that has no realtime server attached simply never registers one and reports
 * nothing rather than zero.
 */
type GaugeReader = () => Record<string, number>;

/**
 * Parked on `globalThis` for the same reason the registry below is, and this
 * one was found the hard way.
 *
 * The socket layer registers its reader from `server.ts`'s module graph.
 * `/api/metrics` is served from Next's, which compiles route handlers into a
 * separate bundle with its own copy of every module. A module-level `Map` here
 * would therefore be written by one copy and read from the other — and the
 * endpoint reported an empty `gauges` block on a process that was holding a
 * hundred live sockets, which is exactly the number the block exists to show.
 */
const globalGauges = globalThis as typeof globalThis & {
  __scribbleGauges?: Map<string, GaugeReader>;
};

const gaugeReaders: Map<string, GaugeReader> = (globalGauges.__scribbleGauges ??= new Map());

export function registerGauges(namespace: string, read: GaugeReader): void {
  gaugeReaders.set(namespace, read);
}

export function clearGauges(): void {
  gaugeReaders.clear();
}

// ------------------------------------------------------------- the instance --

/**
 * The metrics registry, parked on `globalThis`.
 *
 * Same reason as the socket server and the room registry: Next.js compiles
 * route handlers into a separate bundle with its own module registry, so a
 * module-level instance would give the REST layer a different set of counters
 * from the one the socket layer writes to, and `/api/metrics` would report an
 * empty process that was in fact busy.
 */
interface Registry {
  httpDuration: LabelledHistograms;
  socketDuration: LabelledHistograms;
  mongoDuration: LabelledHistograms;
  counters: Counters;
  eventLoop: EventLoopMonitor;
  cpu: CpuMeter;
  startedAt: number;
}

const globalMetrics = globalThis as typeof globalThis & {
  __scribbleMetrics?: Registry;
};

const registry: Registry = (globalMetrics.__scribbleMetrics ??= {
  httpDuration: new LabelledHistograms(),
  socketDuration: new LabelledHistograms(),
  mongoDuration: new LabelledHistograms(),
  counters: new Counters(),
  eventLoop: new EventLoopMonitor(),
  cpu: new CpuMeter(),
  startedAt: Date.now(),
});

export const metrics = {
  /** Begins event-loop sampling. Called once at boot. */
  start(): void {
    registry.eventLoop.start();
  },

  /** Records one REST request. `route` must be a pattern, never a real path. */
  observeHttp(route: string, method: string, status: number, durationMs: number): void {
    registry.httpDuration.observe(`${method} ${route}`, durationMs);
    registry.counters.increment('http.requests');
    if (status >= 500) registry.counters.increment('http.errors.server');
    else if (status >= 400) registry.counters.increment('http.errors.client');
  },

  /** Records one socket handler's execution. */
  observeSocketEvent(event: string, durationMs: number, failed: boolean): void {
    registry.socketDuration.observe(event, durationMs);
    registry.counters.increment('socket.events');
    if (failed) registry.counters.increment('socket.events.failed');
  },

  /** Records one Mongo command. */
  observeMongo(command: string, durationMs: number): void {
    registry.mongoDuration.observe(command, durationMs);
    registry.counters.increment('mongo.commands');
  },

  /** Bumps a named counter. */
  increment(name: string, by = 1): void {
    registry.counters.increment(name, by);
  },

  /** Reads a counter. Used by tests and by the health summary. */
  counter(name: string): number {
    return registry.counters.get(name);
  },

  /**
   * Everything, as one plain object.
   *
   * Safe to serve unauthenticated: it is counts and durations, with labels
   * that are route patterns and event names. Nothing here names a user, a
   * room, an address or a word.
   */
  snapshot(): Record<string, unknown> {
    const memory = process.memoryUsage();
    const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 100) / 100;

    const gauges: Record<string, Record<string, number>> = {};
    for (const [namespace, read] of gaugeReaders) {
      try {
        gauges[namespace] = read();
      } catch {
        // A gauge that throws must not take the whole endpoint down with it —
        // metrics are most valuable exactly when something is broken.
        gauges[namespace] = {};
      }
    }

    return {
      collectedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        cpu: registry.cpu.read(),
        memoryMb: {
          rss: toMb(memory.rss),
          heapUsed: toMb(memory.heapUsed),
          heapTotal: toMb(memory.heapTotal),
          external: toMb(memory.external),
          arrayBuffers: toMb(memory.arrayBuffers),
        },
        eventLoopDelay: registry.eventLoop.snapshot(),
        activeHandles: countHandles(),
      },
      gauges,
      counters: registry.counters.snapshot(),
      http: registry.httpDuration.snapshot(),
      socket: registry.socketDuration.snapshot(),
      mongo: registry.mongoDuration.snapshot(),
    };
  },

  /** Empties every metric. Used by tests and by load-test runs. */
  reset(): void {
    registry.httpDuration.reset();
    registry.socketDuration.reset();
    registry.mongoDuration.reset();
    registry.counters.reset();
    registry.eventLoop.reset();
    registry.startedAt = Date.now();
  },
};

/**
 * How many handles and requests libuv is holding.
 *
 * Undocumented but stable, and the cheapest leak detector there is: a number
 * that climbs and never falls across a load test is a socket, timer or
 * connection that is not being released. Guarded because it is not part of the
 * public API and may simply not be there.
 */
function countHandles(): { handles: number; requests: number } {
  const internals = process as unknown as {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };

  return {
    handles: internals._getActiveHandles?.().length ?? -1,
    requests: internals._getActiveRequests?.().length ?? -1,
  };
}
