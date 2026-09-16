import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';
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
  /**
   * Which rule this bucket spends from.
   *
   * Only the HTTP map needs it, and only to evict safely: a full bucket is
   * indistinguishable from an absent one and is therefore free to drop, but
   * "full" is a property of *this* bucket's rule. Socket buckets are keyed by
   * rule name in a per-connection map and discarded with the connection, so
   * they never need it — it is optional rather than required so those stay a
   * two-field object.
   */
  rule?: RateLimitName;
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
  /**
   * Sending a room invitation.
   *
   * Sized like `friendRequest` and for the same reason: it is the other action
   * in this app that puts a notification in somebody else's list without their
   * asking. The burst covers inviting the four friends you meant to play with
   * in one go; the sustained rate makes an invitation spray pointless.
   *
   * It is not the only bound. `invitation.service.ts` also caps how many
   * invitations one player may have *outstanding* to one room, which is the
   * shape the abuse takes when it is spread over time rather than burst.
   */
  roomInvite: { burst: 6, perSecond: 0.1 },
  /**
   * Answering an invitation.
   *
   * Looser than sending, exactly as `friendAction` is looser than
   * `friendRequest`: these act on a row that already exists and the worst a
   * burst does is churn the caller's own inbox.
   */
  invitationAction: { burst: 20, perSecond: 1 },
  /**
   * Browsing public rooms.
   *
   * A read, and normally an in-memory one, so this is generous — a player
   * pulling to refresh while they wait for a room to fill is doing the thing
   * the screen is for. The burst absorbs that; the sustained rate stops a
   * client stuck in a polling loop from scanning Mongo several times a second
   * in the split deployment, where this read is not in memory.
   */
  publicRooms: { burst: 15, perSecond: 1 },
  /**
   * Reading the notification inbox.
   *
   * A read, and one a client makes on every app open and every pull to
   * refresh, so this is generous. The sustained rate is what stops a client
   * stuck in a polling loop from running three indexed queries a second
   * against the collection with the highest write rate in the app.
   */
  notificationRead: { burst: 20, perSecond: 2 },
  /**
   * Marking read, marking all read, deleting.
   *
   * Looser than reading and sized like `friendAction`, for the same reason:
   * every one of these acts on a row the caller already owns, so the worst a
   * burst does is churn their own inbox. The burst covers clearing a backlog
   * by tapping through it.
   */
  notificationAction: { burst: 30, perSecond: 2 },
  /**
   * Reading levels, XP history and the achievement catalogue.
   *
   * All reads, and the catalogue is a constant — the only database work is one
   * user row and one small collection scan per call. Generous accordingly; the
   * sustained rate exists to stop a client polling a progress bar.
   */
  progressionRead: { burst: 20, perSecond: 2 },
  /**
   * Reading drawing replays.
   *
   * Tighter than the other reads because one response can be the largest
   * payload this API serves — a whole turn's strokes. The burst covers a
   * player stepping through a match's turns one after another; the sustained
   * rate makes pulling every drawing off the server in a loop slow enough to
   * be pointless.
   */
  replayRead: { burst: 10, perSecond: 0.5 },
  /**
   * Typing notifications.
   *
   * The chattiest event in the protocol and the cheapest — it is relayed and
   * nothing else. Generous enough that a fast typist never trips it, bounded
   * so a client cannot turn a keystroke stream into a broadcast storm.
   */
  typing: { burst: 20, perSecond: 3 },
  /**
   * Reacting to and deleting messages.
   *
   * Deliberately *not* the `guess` bucket the send handler shares. A player
   * reacting to a funny line must not spend the tokens they need to guess
   * with, or a room enjoying itself would find it could no longer play.
   */
  chatAction: { burst: 15, perSecond: 2 },
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
    bucket = { tokens: rule.burst, updatedAt: now, rule: name };
    httpBuckets.set(key, bucket);
  }

  if (!spend(bucket, rule, now)) throw errors.rateLimited();

  if (httpBuckets.size > HTTP_BUCKET_CEILING) evictFullBuckets(now);
}

/** When the HTTP map is swept, and how far down. */
const HTTP_BUCKET_CEILING = 10_000;
const HTTP_BUCKET_TARGET = 5_000;

/**
 * Drops buckets that have refilled, keeping the map from growing without bound.
 *
 * A bucket at its rule's burst has no memory of anything — recreating it on the
 * next request produces exactly the same object — so dropping it is free.
 *
 * ## Why each bucket is measured against its own rule
 *
 * This used to compare every bucket against `RATE_LIMITS.action.burst`, which
 * is 20. A `guess` bucket holds at most 8 tokens, `chat` 6, `guestLogin` 5:
 * none of them can ever reach 20, so none of them was ever evicted. A map that
 * filled with those would scan all ten thousand entries, delete nothing, and
 * then do it again on the very next request — the map grew without bound *and*
 * every request got slower. Comparing against `RATE_LIMITS[candidate.rule]`
 * is what makes the sweep actually reclaim.
 *
 * Buckets are refilled before being measured, because a bucket sitting idle
 * since its last spend is full in every sense that matters and only looks
 * partial because nothing has touched it since.
 */
function evictFullBuckets(now: number): void {
  for (const [key, bucket] of httpBuckets) {
    const rule = bucket.rule ? RATE_LIMITS[bucket.rule] : RATE_LIMITS.action;

    const elapsedSeconds = (now - bucket.updatedAt) / 1000;
    const tokens = Math.min(rule.burst, bucket.tokens + elapsedSeconds * rule.perSecond);

    if (tokens >= rule.burst) httpBuckets.delete(key);
    if (httpBuckets.size <= HTTP_BUCKET_TARGET) return;
  }

  // Every remaining bucket is mid-refill, so none of them is free to drop and
  // the map is legitimately this large — a burst of genuinely active callers.
  // Clearing it anyway would hand every one of them a fresh allowance, which
  // is the opposite of what a rate limiter is for, so it is left alone and
  // reported instead.
  if (httpBuckets.size > HTTP_BUCKET_CEILING) {
    logger.warn('rate limit buckets above ceiling after a sweep', {
      size: httpBuckets.size,
    });
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
