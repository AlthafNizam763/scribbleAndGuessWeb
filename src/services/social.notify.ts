import { emitToUser } from '@/config/socket';
import { FRIEND_EVENTS, type FriendEventName } from '@/constants/socket.constants';
import { logger } from '@/utils/logger';

/**
 * Pushing friend-list changes to the people they concern.
 *
 * ## Why this is a seam and not an `emitToUser` at each call site
 *
 * Three things have to be true of every one of these pushes, and stating them
 * once is the only way they stay true:
 *
 * 1. **It reaches a person, not a connection.** The target is a user channel,
 *    so a player signed in on a phone and a tablet sees the request appear on
 *    both. `emitToUser` already does this; the point is that nothing here may
 *    reach for a socket id instead.
 *
 * 2. **It carries nothing sensitive.** The payloads are a request id and a
 *    public card — name, avatar, id. No email, no token, no block state, no
 *    stats. A friend event is a nudge to refresh, not a data channel, and the
 *    client re-reads the authoritative list over REST when it lands.
 *
 * 3. **It cannot fail the action that caused it.** Every call is fire and
 *    forget. A friendship that was accepted in Mongo is accepted whether or
 *    not the other party had a socket open, so a broadcast failure is logged
 *    and swallowed rather than rolled back into an error the acting user would
 *    have to read.
 *
 * ## Realtime is an optimisation here, not the transport
 *
 * There is no socket handler for sending or accepting a request: those are
 * REST calls. These events only tell a client that its cached list is stale.
 * A client that missed one — it was offline, or the realtime process is
 * deployed separately and was restarting — is never wrong for long, because
 * pull-to-refresh and the next screen open both re-read the list.
 */

/** What a friend event may carry. Public display data only. */
export type FriendEventPayload = Record<string, unknown>;

/**
 * Emits one friend event to one user.
 *
 * Sent under two names: the canonical `s:friend:*` spelling this codebase uses
 * for every other server-to-client event, and the flatter `friend:*` spelling
 * the brief names. They are the same payload on the same channel, so a client
 * listens for whichever vocabulary it was written against and neither has to
 * be migrated. Nothing listens for both, so nothing sees a duplicate.
 */
export function notifyFriendEvent(
  userId: string,
  name: FriendEventName,
  payload: FriendEventPayload = {},
): void {
  const event = FRIEND_EVENTS[name];

  try {
    const body = { ...payload, atMs: Date.now() };
    emitToUser(userId, event.canonical, body);
    emitToUser(userId, event.alias, body);
  } catch (error) {
    // A push nobody received costs a refresh, never correctness.
    logger.exception('friend event broadcast failed', error, { userId, event: event.canonical });
  }
}
