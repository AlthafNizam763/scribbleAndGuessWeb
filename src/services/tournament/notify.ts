import { emitToUser, getSocketServer } from '@/config/socket';
import {
  TOURNAMENT_EVENTS,
  TOURNAMENT_LOBBY_CHANNEL,
  type TournamentEventName,
} from '@/constants/socket.constants';
import { logger } from '@/utils/logger';

/**
 * Tournament announcements.
 *
 * ## Why a helper rather than `emitToRoom` at each site
 *
 * Every one of these events has to go out under two names — the canonical
 * `s:tournament:*` and the flatter `tournament:*` the brief specifies — so a
 * client written against either vocabulary works. Doing that at each of the
 * fifteen call sites is fifteen chances to emit one name and not the other,
 * and the failure is invisible: the client that listens for the name you
 * forgot simply never updates.
 *
 * ## Why most of this is a broadcast and one thing is not
 *
 * A tournament is public. The three-slot listing is the same for everybody, so
 * lifecycle events fan out to a lobby channel any client may join and the
 * listing refreshes itself without polling.
 *
 * `matchReady` is the exception. It carries the room code of a protected room,
 * and the only people with any business knowing it are the two playing in it.
 * It goes to their user channels, which reaches every device each of them is
 * signed in on and nobody else's.
 *
 * ## What happens with no socket server
 *
 * Nothing, quietly. In the split deployment the REST process holds no Socket.IO
 * instance at all, and a scheduler tick there must not fail because it could
 * not announce something. The listing endpoints are authoritative either way;
 * these events are how a client avoids polling, not how it learns the truth.
 */

/**
 * The identity block every tournament event carries.
 *
 * ## Why this is a function and not three fields typed out fifteen times
 *
 * Because a client receiving `tournament:registration_updated` has to know
 * *which* tournament changed, and on a screen showing three cards for today
 * the answer is not obvious from anything else in the payload. An event that
 * omitted it would update the wrong card or, more likely, force a re-read of
 * the whole listing — which is the polling this channel exists to avoid.
 *
 * The status is passed separately rather than read off the row, because at
 * almost every call site the row in hand is the *old* one: the update that
 * moved it has already run, and the document was loaded before that. Taking
 * `row.status` would announce every transition as the state it just left.
 */
export function tournamentRef(
  row: {
    _id: unknown;
    tournamentDate?: string;
    dailySlot?: string;
    slotNumber?: number;
    name?: string;
  },
  status: string,
): Record<string, unknown> {
  return {
    tournamentId: String(row._id),
    tournamentDate: row.tournamentDate,
    dailySlot: row.dailySlot,
    slotNumber: row.slotNumber,
    name: row.name,
    status,
  };
}

/** Fans one event out to everybody watching the tournament listing. */
export function announceTournament(
  event: TournamentEventName,
  payload: Record<string, unknown>,
): void {
  const server = getSocketServer();
  if (!server) return;

  const names = TOURNAMENT_EVENTS[event];

  try {
    server.to(TOURNAMENT_LOBBY_CHANNEL).emit(names.canonical, payload);
    server.to(TOURNAMENT_LOBBY_CHANNEL).emit(names.alias, payload);
  } catch (error) {
    // An announcement that failed costs a client one poll cycle. It must never
    // cost the transition that produced it.
    logger.exception('tournament announcement failed', error, { event });
  }
}

/** Sends one event to one person, on every device they are signed in on. */
export function announceToPlayer(
  userId: string,
  event: TournamentEventName,
  payload: Record<string, unknown>,
): void {
  const names = TOURNAMENT_EVENTS[event];

  try {
    emitToUser(userId, names.canonical, payload);
    emitToUser(userId, names.alias, payload);
  } catch (error) {
    logger.exception('tournament player announcement failed', error, { event, userId });
  }
}
