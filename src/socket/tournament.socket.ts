import {
  CLIENT_TOURNAMENT_UNWATCH,
  CLIENT_TOURNAMENT_WATCH,
  TOURNAMENT_LOBBY_CHANNEL,
} from '@/constants/socket.constants';
import { on } from '@/socket/handler';
import type { GameSocket } from '@/types/socket.types';

/**
 * Subscribing to tournament announcements.
 *
 * ## Two verbs, and no third
 *
 * A client joins the lobby channel when it opens the tournament screen and
 * leaves when it closes. That is the whole protocol. There is no inbound event
 * that registers, checks in or enters a match — those are REST calls, because
 * each has to be refused for reasons the player needs spelled out
 * ("registration has closed for this tournament", "that tournament is full"),
 * and a fire-and-forget socket event has nowhere to put that.
 *
 * ## Why a channel rather than a global broadcast
 *
 * `io.emit` reaches every socket in the process, including the ones mid-round
 * with a canvas to keep up with. A player in a match has no use for "the
 * evening tournament opened registration", and a drawing turn is the last
 * place to spend bandwidth on it. The channel means the fan-out reaches the
 * screens that are actually showing a tournament.
 *
 * Joining is idempotent in Socket.IO, so a client that re-sends this after a
 * reconnect — which it should, because channel membership does not survive one
 * — ends up in the channel once.
 */
export function registerTournamentHandlers(socket: GameSocket): void {
  on(
    socket,
    CLIENT_TOURNAMENT_WATCH,
    ({ socket: sock }) => {
      sock.join(TOURNAMENT_LOBBY_CHANNEL);
      return { watching: true };
    },
    { limit: 'action' },
  );

  on(
    socket,
    CLIENT_TOURNAMENT_UNWATCH,
    ({ socket: sock }) => {
      sock.leave(TOURNAMENT_LOBBY_CHANNEL);
      return { watching: false };
    },
    { limit: 'action' },
  );
}
