import type { Server as HttpServer } from 'node:http';

import { createSocketServer } from '@/config/socket';
import { TIMING } from '@/constants/game.constants';
import { GAME_PHASE } from '@/constants/room.constants';
import { roomChannel, SERVER_TIME_SYNC } from '@/constants/socket.constants';
import { metrics, registerGauges } from '@/monitoring/metrics';
import { invitationService } from '@/services/invitation.service';
import { botPlayerService } from '@/services/bot/botPlayer.service';
import { presenceService } from '@/services/presence.service';
import { tournamentBot } from '@/services/tournament/bot.service';
import { roomService } from '@/services/room.service';
import { registerChatExtrasHandlers, registerChatHandlers } from '@/socket/chat.socket';
import { registerDrawingHandlers } from '@/socket/drawing.socket';
import { registerGameHandlers } from '@/socket/game.socket';
import { registerPresenceHandlers } from '@/socket/presence.socket';
import { registerRoomHandlers, registerSpectatorHandlers } from '@/socket/room.socket';
import { registerTournamentHandlers } from '@/socket/tournament.socket';
import { registerVoiceHandlers } from '@/socket/voice.socket';
import { installSocketAuth } from '@/socket/socket.auth';
import type { GameServer, GameSocket } from '@/types/socket.types';
import { logger } from '@/utils/logger';

/**
 * Boots the realtime server (brief sections 14 to 16).
 *
 * Attached to the same HTTP server Next.js is serving from, so one port
 * carries both the REST API and the websocket. That is what keeps deployment
 * simple and what makes the reverse-proxy story in brief section 68 a matter
 * of forwarding one origin with upgrade headers rather than two services.
 */

/**
 * The phases that put a countdown on somebody's screen.
 *
 * These are the rooms whose clients are subtracting their clock drift from a
 * server deadline to render a timer, and therefore the only ones with any use
 * for a periodic clock frame. A lobby, a scoreboard and a paused match all
 * show a number that is not counting down.
 */
const TIMED_PHASES: ReadonlySet<string> = new Set<string>([
  GAME_PHASE.starting,
  GAME_PHASE.wordSelection,
  GAME_PHASE.drawing,
  GAME_PHASE.roundEnd,
  GAME_PHASE.gameEnd,
]);

let started = false;

export function attachSocketServer(httpServer: HttpServer): GameServer {
  const io = createSocketServer(httpServer);

  // Rejects unauthenticated sockets before any handler can run.
  installSocketAuth(io);

  registerRealtimeGauges(io);

  io.on('connection', (socket) => {
    const gameSocket = socket as GameSocket;

    metrics.increment('socket.connections');

    logger.debug('socket connected', { userId: gameSocket.data.user.id });

    // Counted here rather than in the disconnect handler in
    // `presence.socket.ts`, which returns early for a socket that was not in a
    // room — and a socket dropping out of a menu is exactly as interesting to
    // a leak hunt as one dropping out of a game.
    //
    // The reason is bucketed by Socket.IO's own vocabulary, which is a fixed
    // set of about eight strings, so this cannot grow an unbounded label.
    gameSocket.on('disconnect', (reason: string) => {
      metrics.increment('socket.disconnections');
      metrics.increment(`socket.disconnect.${reason}`);
    });

    registerPresenceHandlers(gameSocket);
    registerRoomHandlers(gameSocket);
    registerGameHandlers(gameSocket);
    registerDrawingHandlers(gameSocket);
    registerChatHandlers(gameSocket);
    registerChatExtrasHandlers(gameSocket);
    registerSpectatorHandlers(gameSocket);
    registerVoiceHandlers(gameSocket);
    registerTournamentHandlers(gameSocket);

    // Seeds the client's clock estimate immediately, so a countdown is
    // displayable before the first `c:time:ping` round trip completes.
    gameSocket.emit(SERVER_TIME_SYNC, { serverTimeMs: Date.now() });
  });

  if (!started) {
    started = true;

    // A one-way clock broadcast. The client folds it in with a small weight
    // because it carries no round-trip information; the ping/pong measurement
    // stays in charge of the offset.
    //
    // Sent into the room channels that have a countdown on screen rather than
    // with `io.emit`, which reaches every connected socket in the process.
    // A player sitting in the friends list or browsing rooms has no deadline
    // to render, so a clock frame for them is a packet that changes nothing —
    // and a global fan-out is the one shape of broadcast this server otherwise
    // never uses. Everybody still gets a seed frame on connection, and
    // `c:time:ping` — which is the measurement that actually sets the offset —
    // is unaffected and available to any socket at any time.
    const clock = setInterval(() => {
      const serverTimeMs = Date.now();
      for (const room of roomService.all()) {
        if (!TIMED_PHASES.has(room.phase)) continue;
        io.to(roomChannel(room.roomId)).emit(SERVER_TIME_SYNC, { serverTimeMs });
      }
    }, TIMING.timeSyncIntervalMs);
    clock.unref?.();

    presenceService.startSweeper();

    // Retires invitations nobody answered. On its own interval rather than
    // folded into the room sweep because the two are unrelated: an invitation
    // lapses on its own clock whether or not any room changed, and the room
    // sweep runs twice as often as this needs to.
    //
    // Correctness never depends on it. The accept path compares against
    // `expiresAt` directly, so a lapsed invitation is refused whether or not
    // the sweeper has reached it; what this buys is releasing the unique-index
    // slot, so the same friend can be invited to that room again.
    const invitations = setInterval(() => {
      void invitationService.expireLapsed();
    }, TIMING.invitationSweepIntervalMs);
    invitations.unref?.();

    // The automatic tournament organiser.
    //
    // Started here rather than in `server.ts` because this is the process that
    // actually holds the rooms: a scheduler that opened a match room in a
    // process with no socket server would create a room nobody could join.
    // In the split deployment that means the realtime service runs the
    // organiser and the REST service does not, which is the right division —
    // and the `socket-server.ts` entry point calls this same function.
    //
    // It takes a distributed lock, so a second instance behind a load balancer
    // is harmless: one of them does the tick.
    void tournamentBot.start().catch((error: unknown) => {
      // A failed start costs tournaments, never the game. The server carries
      // on serving rooms and the next deploy tries again.
      logger.exception('failed to start the tournament organiser', error);
    });
  }

  logger.info('socket.io attached');
  return io;
}

/**
 * Publishes the live realtime counts to the metrics endpoint.
 *
 * A reader rather than a periodic write, because these are all cheap
 * point-in-time reads of structures that already exist — `engine.clientsCount`
 * is a field, and the room registry is a `Map`. Sampling them on a timer would
 * add a background task to keep a number fresh that nothing reads between
 * scrapes.
 *
 * Registered here rather than in `metrics.ts` because the metrics module must
 * not import the socket server or the room registry: those report *into* it,
 * and the dependency going both ways is a cycle.
 */
function registerRealtimeGauges(io: GameServer): void {
  registerGauges('realtime', () => {
    const rooms = roomService.all();

    let players = 0;
    let seatsOccupied = 0;
    let roomsInGame = 0;
    let voiceParticipants = 0;
    let strokesHeld = 0;

    for (const room of rooms) {
      seatsOccupied += room.players.size;
      voiceParticipants += room.voice.members.size;
      strokesHeld += room.board.strokes.length;

      if (TIMED_PHASES.has(room.phase)) roomsInGame += 1;

      for (const player of room.players.values()) {
        if (player.socketIds.size > 0) players += 1;
      }
    }

    return {
      // Every socket attached to this process, in a room or not.
      socketsConnected: io.engine?.clientsCount ?? 0,
      rooms: rooms.length,
      roomsInGame,
      // Seats held, including players inside their reconnect grace period.
      seatsOccupied,
      // Seats with a live connection behind them. The gap between this and
      // `seatsOccupied` is how many people are currently reconnecting.
      playersConnected: players,
      voiceParticipants,
      // The board memory this process is holding. A number that climbs across
      // a load test and never falls is a room that is not being swept.
      strokesHeld,
      // AI players holding a live drawing or guessing timer. Bounded by
      // `BOT_LIMITS.maxConcurrentWorkers`, so a number sitting at the ceiling
      // means bots are being skipped — and one that never falls to zero
      // between matches means a task is not being cleaned up.
      botWorkers: botPlayerService.activeWorkers(),
    };
  });
}
