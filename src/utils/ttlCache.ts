/**
 * A bounded, time-limited cache (brief section 10).
 *
 * ## What this is for, and what it is not for
 *
 * The reads worth caching in this app share a shape: they are asked far more
 * often than the answer changes, they are the same for every caller or keyed
 * by one user, and a slightly stale answer is harmless. A block list is the
 * clearest example — it gates matchmaking and the room browser, is consulted
 * on every Quick Play and every pull-to-refresh, and changes when somebody
 * taps Block, which is approximately never.
 *
 * It is deliberately **not** a general-purpose store. Nothing authoritative
 * goes in here: not a room's occupancy, not a score, not a game phase. Those
 * are decided in memory by the services that own them, and a cached copy of
 * one is a second answer waiting to disagree with the first.
 *
 * ## Why entries expire *and* the map is bounded
 *
 * A TTL alone does not bound memory: a process that sees a hundred thousand
 * distinct keys in one TTL window holds a hundred thousand entries, expired or
 * not, because nothing sweeps them. So there is a ceiling too, and reaching it
 * drops the oldest-inserted entries — insertion order is what a `Map` iterates
 * in, so this costs no extra bookkeeping.
 *
 * ## Why it is process-local
 *
 * The same reason every other piece of live state here is: a user's traffic is
 * pinned to one process by their socket, and the REST reads this serves are
 * idempotent. A second process holding a slightly different block list changes
 * nothing about correctness — both would refuse the same joins, because the
 * join path re-checks against the database rather than against this.
 */

interface Entry<V> {
  value: V;
  /** When this entry stops being served, as an epoch milliseconds stamp. */
  expiresAt: number;
}

export interface TtlCacheOptions {
  /** How long an entry is served for, in milliseconds. */
  ttlMs: number;
  /** The most entries held at once. Oldest insertions are dropped first. */
  maxEntries?: number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 5_000;
  }

  /** The cached value, or undefined when absent or expired. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /** Stores a value, evicting the oldest insertions if the cache is full. */
  set(key: string, value: V): void {
    // Delete first so a re-set moves the key to the back of the insertion
    // order. Without it a hot key keeps its original position and is evicted
    // ahead of colder keys written after it.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Returns the cached value, or computes and caches it.
   *
   * A rejected `load` is not cached: a failed database read should be retried
   * on the next request, not remembered as an answer for the whole TTL.
   */
  async remember(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const value = await load();
    this.set(key, value);
    return value;
  }

  /** Drops one key. Call this from whatever writes the underlying data. */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Drops several keys. */
  invalidateAll(keys: Iterable<string>): void {
    for (const key of keys) this.entries.delete(key);
  }

  /** Empties the cache. Used by tests and by wholesale invalidation. */
  clear(): void {
    this.entries.clear();
  }

  /** How many entries are held, expired ones included. For metrics. */
  get size(): number {
    return this.entries.size;
  }
}
