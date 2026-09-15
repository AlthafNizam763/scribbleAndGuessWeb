import { errors } from '@/utils/errors';
import type { GameSocket } from '@/types/socket.types';

/**
 * Rate limiting (brief section 51).
 *
 * ## Token buckets, not fixed windows
 *
 * A fixed window lets a caller spend their whole allowance in the last
 * millisecond of one window and again in the first of the next — twice the
 * intended rate, at exactly the worst moment. A token bucket refills
 * continuously, so the *average* rate is what the limit says while short
 * bursts still go through. Bursts matter here: a player types three quick
 * guesses when they think they have it, and throttling that feels broken.
 *
 * ## Why drawing is not in this file's HTTP path
 *
 * Strokes are limited by size and count in `drawing.service.ts` rather than by
 * request rate. A drawer legitimately emits ~17 batches a second, so a rate
 * limit tuned for chat would cut the game's core interaction; what needs
 * bounding there is how much *data* a client can push, not how often.
 *
 * ## Scope
 *
 * Buckets are per-process and in memory. That is the right scope for socket
 * traffic, which is pinned to one process by the connection anyway. A
 * multi-process deployment would want a shared store for the REST limits;
 * the interface here does not change when that happens.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitRule {
  /** Bucket size: the largest burst allowed. */
  burst: number;
  /** Sustained rate, in operations per second. */
  perSecond: number;
}

/** The limits, one per protected action. */
export const RATE_LIMITS = {
  /** Account creation. Low, because each one writes a row. */
  guestLogin: { burst: 5, perSecond: 0.05 },
  createRoom: { burst: 5, perSecond: 0.1 },
  joinRoom: { burst: 10, perSecond: 0.5 },
  /** Generous: guessing fast is the game. */
  guess: { burst: 8, perSecond: 2 },
  chat: { burst: 6, perSecond: 1 },
  voteKick: { burst: 3, perSecond: 0.1 },
  report: { burst: 3, perSecond: 0.05 },
  moderation: { burst: 10, perSecond: 1 },
  /** The whole-stroke lifecycle, generous enough for a live pen. */
  drawing: { burst: 120, perSecond: 60 },
  /**
   * Joining, leaving and muting voice. Roughly one join per turn plus however
   * often somebody taps the microphone button, so the sustained rate is low
   * and the burst absorbs a reconnect storm.
   */
  voice: { burst: 12, perSecond: 1 },
  /**
   * Offers, answers and ICE candidates.
   *
   * Sized for the mesh rather than for one connection: five guessers means
   * four peers, and each peer costs an offer or answer plus a dozen or so
   * candidates, all of them arriving in the same second or two as a turn
   * opens. Too tight a limit here does not throttle abuse, it drops the
   * candidate that would have completed a call.
   */
  voiceSignal: { burst: 200, perSecond: 25 },
  /**
   * Sending a friend request.
   *
   * The tightest limit in this table after account creation, because it is the
   * one action here that puts a notification in a stranger's list. A burst of
   * five covers adding the people you just played a match with; the sustained
   * rate of one every twenty seconds makes spraying requests across the user
   * table pointless.
   */
  friendRequest: { burst: 5, perSecond: 0.05 },
  /**
   * Accepting, rejecting, cancelling, unfriending, blocking, unblocking.
   *
   * Looser than sending: these all act on a relationship that already exists,
   * so the worst a burst does is churn the caller's own lists. Sized to let
   * somebody clear a backlog of requests in one sitting.
   */
  friendAction: { burst: 20, perSecond: 1 },
  /**
   * User search.
   *
   * The expensive read in this feature — an anchored case-insensitive regex
   * cannot seek in the index — so it is limited per caller even though it is
   * also hard-capped at twenty-five results. The burst absorbs type-ahead:
   * a client searching on every keystroke spends one token per character of
   * a name, which is what the ten-token bucket is sized for.
   */
  userSearch: { burst: 10, perSecond: 2 },
  /**
   * Quick Play.
   *
   * Low on purpose: each call can create a room, which is the same cost as
   * `createRoom` and is limited to match. The per-user in-flight gate in
   * `matchmaking.service.ts` handles the double-tap case; this handles the
   * client stuck in a retry loop.
   */
  quickPlay: { burst: 5, perSecond: 0.2 },
  /** Anything else with an ack. */
  action: { burst: 20, perSecond: 5 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** Buckets for HTTP callers, keyed by `action:identity`. */
const httpBuckets = new Map<string, Bucket>();

/**
 * Spends one token, returning whether it was available.
 *
 * The bucket refills lazily from elapsed time, so there is no timer and no
 * sweep of idle entries on a hot path.
 */
function spend(bucket: Bucket, rule: RateLimitRule, now: number): boolean {
  const elapsedSeconds = (now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(rule.burst, bucket.tokens + elapsedSeconds * rule.perSecond);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) return false;

  bucket.tokens -= 1;
  return true;
}

/**
 * Rate-limits an HTTP caller, throwing `RATE_LIMITED` when they are over.
 *
 * `identity` should be a user id where one is known and a client address
 * otherwise. Guest login has no user yet, which is exactly why it is limited
 * by address.
 */
export function enforceHttpLimit(name: RateLimitName, identity: string): void {
  const rule = RATE_LIMITS[name];
  const key = `${name}:${identity}`;
  const now = Date.now();

  let bucket = httpBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: rule.burst, updatedAt: now };
    httpBuckets.set(key, bucket);
  }

  if (!spend(bucket, rule, now)) throw errors.rateLimited();

  // Keep the map from growing without bound on a long-lived process. Full
  // buckets are indistinguishable from absent ones, so dropping them is free.
  if (httpBuckets.size > 10_000) {
    for (const [candidateKey, candidate] of httpBuckets) {
      if (candidate.tokens >= RATE_LIMITS.action.burst) httpBuckets.delete(candidateKey);
      if (httpBuckets.size <= 5000) break;
    }
  }
}

/**
 * Rate-limits a socket action.
 *
 * Buckets hang off the socket itself, so they are discarded with the
 * connection and a reconnect starts fresh — which is fine, because
 * reconnecting is far more expensive than the traffic being limited.
 */
export function enforceSocketLimit(socket: GameSocket, name: RateLimitName): void {
  const rule = RATE_LIMITS[name];
  const now = Date.now();

  let bucket = socket.data.buckets.get(name);
  if (!bucket) {
    bucket = { tokens: rule.burst, updatedAt: now };
    socket.data.buckets.set(name, bucket);
  }

  if (!spend(bucket, rule, now)) throw errors.rateLimited();
}

/**
 * The best available identity for an HTTP caller.
 *
 * Behind a reverse proxy the socket address is the proxy, so
 * `x-forwarded-for`'s first entry is used when present. That header is
 * client-controllable when there is *no* trusted proxy in front, which would
 * let a caller evade the limit — acceptable here because these limits protect
 * against accident and casual abuse, and the expensive endpoints are
 * additionally bounded by their own database costs.
 */
export function clientIdentity(request: Request, userId?: string): string {
  if (userId) return `user:${userId}`;

  const forwarded = request.headers.get('x-forwarded-for');
  const address = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';

  return `ip:${address}`;
}

/** Clears every bucket. Used by tests. */
export function resetRateLimits(): void {
  httpBuckets.clear();
}
