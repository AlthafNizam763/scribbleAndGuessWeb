import { emitToRoom, emitToUser } from '@/config/socket';
import { ROOM_EVENTS, type RoomEventName } from '@/constants/socket.constants';
import { logger } from '@/utils/logger';

/**
 * Pushing invitation and membership changes to the people they concern.
 *
 * ## Why this is a seam and not an `emitToUser` at each call site
 *
 * The same three properties `social.notify.ts` states for friend events have
 * to hold here, and stating them once is what keeps them true:
 *
 * 1. **It reaches a person or a room, never a connection.** An invitation goes
 *    to `userChannel`, so it lands on the phone and the tablet; a membership
 *    change goes to `roomChannel`, so it reaches everybody seated and nobody
 *    else. Nothing here may reach for a socket id.
 *
 * 2. **It carries nothing the recipient may not see.** Invitations carry a
 *    public card, a room code and an occupancy count. A membership event
 *    carries the player and the room snapshot, which is the same payload
 *    `s:room:state` already broadcasts to that channel. No word, no token, no
 *    email, no block state.
 *
 * 3. **It cannot fail the action that caused it.** Every call is fire and
 *    forget. An invitation written to Mongo exists whether or not the invitee
 *    had a socket open, and a seat taken is taken whether or not the broadcast
 *    landed — so a failure here is logged and swallowed rather than turned
 *    into an error the acting player would have to read.
 *
 * ## Realtime is an optimisation, not the transport
 *
 * Every one of these events has a REST read behind it: the invitations list,
 * the room snapshot, the members endpoint. A client that missed a push — it
 * was backgrounded, the realtime process was restarting — is never wrong for
 * long, because opening the screen re-reads the authoritative state. That is
 * what makes it safe for these to be best-effort.
 */

/** What a room event may carry. Public display data only. */
export type RoomEventPayload = Record<string, unknown>;

/**
 * Emits one room event to one user, across their devices.
 *
 * Sent under both the canonical `s:room:*` name and the brief's flatter
 * `room:*` alias, with the same payload, so a client listens for whichever
 * vocabulary it was written against. Nothing listens for both.
 */
export function notifyUserRoomEvent(
  userId: string,
  name: RoomEventName,
  payload: RoomEventPayload = {},
): void {
  const event = ROOM_EVENTS[name];

  try {
    const body = { ...payload, atMs: Date.now() };
    emitToUser(userId, event.canonical, body);
    emitToUser(userId, event.alias, body);
  } catch (error) {
    logger.exception('room event broadcast failed', error, {
      userId,
      event: event.canonical,
    });
  }
}

/** Emits one room event to everybody seated in a room. */
export function notifyRoomEvent(
  roomId: string,
  name: RoomEventName,
  payload: RoomEventPayload = {},
): void {
  const event = ROOM_EVENTS[name];

  try {
    const body = { ...payload, atMs: Date.now() };
    emitToRoom(roomId, event.canonical, body);
    emitToRoom(roomId, event.alias, body);
  } catch (error) {
    logger.exception('room event broadcast failed', error, {
      roomId,
      event: event.canonical,
    });
  }
}
