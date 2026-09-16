/**
 * Measurement for the load suite (brief section 12).
 *
 * ## Why the numbers are recorded here rather than read off the server
 *
 * `/api/metrics` reports what the *server* thinks happened. This records what
 * the *client* experienced, which is the figure the brief asks for and the
 * only one that includes queueing, connection setup and the network. The two
 * are read together in the final report: a p99 that is high here and low there
 * means the server is fine and something in front of it is not.
 *
 * ## Why every sample is kept
 *
 * Unlike the production histogram in `src/monitoring/metrics.ts`, this runs for
 * a bounded few minutes against a known number of virtual users, so the sample
 * count is knowable in advance and small. Keeping every one makes the
 * percentiles exact rather than estimated, which matters when the whole point
 * of the exercise is to put a defensible number in a report.
 */

export interface Summary {
  count: number;
  errors: number;
  errorRate: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

/** One named operation's timings and failures. */
class Series {
  private readonly samples: number[] = [];
  private errorCount = 0;
  /** Failure messages, deduplicated, so a report can say *what* went wrong. */
  readonly failures = new Map<string, number>();

  observe(durationMs: number): void {
    this.samples.push(durationMs);
  }

  fail(reason: string, durationMs?: number): void {
    this.errorCount += 1;
    // A failure still took time, and excluding it would flatter the latency
    // figures exactly when the server is struggling.
    if (typeof durationMs === 'number') this.samples.push(durationMs);

    const key = reason.slice(0, 200);
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
  }

  summary(): Summary {
    const count = this.samples.length;
    if (count === 0) {
      return {
        count: 0,
        errors: this.errorCount,
        errorRate: this.errorCount > 0 ? 1 : 0,
        meanMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        minMs: 0,
        maxMs: 0,
      };
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (fraction: number): number =>
      round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0);

    return {
      count,
      errors: this.errorCount,
      errorRate: round(this.errorCount / Math.max(1, count + this.errorCount)),
      meanMs: round(sorted.reduce((total, value) => total + value, 0) / count),
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      p99Ms: at(0.99),
      minMs: round(sorted[0] ?? 0),
      maxMs: round(sorted[sorted.length - 1] ?? 0),
    };
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export class Recorder {
  private readonly series = new Map<string, Series>();
  private readonly counters = new Map<string, number>();

  private of(name: string): Series {
    let series = this.series.get(name);
    if (!series) {
      series = new Series();
      this.series.set(name, series);
    }
    return series;
  }

  /** Times an operation, recording it as a success or a failure. */
  async time<T>(name: string, operation: () => Promise<T>): Promise<T | null> {
    const startedAt = performance.now();
    try {
      const result = await operation();
      this.of(name).observe(performance.now() - startedAt);
      return result;
    } catch (error) {
      this.of(name).fail(describe(error), performance.now() - startedAt);
      return null;
    }
  }

  /** Records a duration measured elsewhere — an event's arrival, say. */
  observe(name: string, durationMs: number): void {
    this.of(name).observe(durationMs);
  }

  fail(name: string, reason: string): void {
    this.of(name).fail(reason);
  }

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  summaries(): Record<string, Summary> {
    const out: Record<string, Summary> = {};
    for (const [name, series] of [...this.series].sort(([a], [b]) => a.localeCompare(b))) {
      out[name] = series.summary();
    }
    return out;
  }

  /** The distinct failures seen, worst first. For the report's detail. */
  failures(): Array<{ operation: string; reason: string; count: number }> {
    const rows: Array<{ operation: string; reason: string; count: number }> = [];
    for (const [operation, series] of this.series) {
      for (const [reason, count] of series.failures) rows.push({ operation, reason, count });
    }
    return rows.sort((a, b) => b.count - a.count);
  }

  countersSnapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters].sort(([a], [b]) => a.localeCompare(b)));
  }
}

/** A thrown value as one short line. */
export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'object' && error !== null) {
    const payload = error as { code?: unknown; message?: unknown };
    if (payload.code || payload.message) return `${String(payload.code)}: ${String(payload.message)}`;
  }
  return String(error);
}
