import { BOT_DIFFICULTY } from '@/constants/autoTournament.constants';
import { gameDefinition } from '@/games/catalog';
import type { GameId } from '@/games/game.types';
import { GameRoom, type GameRoomHydrated } from '@/models/GameRoom';
import { gamePlatformService } from '@/services/game_platform.service';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Playing the same table again.
 *
 * ## Why this is an offer and not a button
 *
 * The naive version — "Play again" re-seats everybody and starts — traps
 * people. A table of five where two want another round and three have had
 * enough leaves those three in a room they did not choose, and the only way
 * out is to back out of a screen that is already starting a match. So a
 * rematch is a *proposal* with a deadline: everybody answers, the ones who
 * said yes play, and the ones who said no are out of the room before the next
 * deal. Nobody is ever carried into a match they did not agree to.
 *
 * ## The server is the one that counts
 *
 * Acceptances are recorded on the room document, the deadline is a server
 * timer, and whether there are enough players is decided against the same
 * `minPlayers` the first match was validated against. A client can ask, and
 * can answer; it cannot start anything.
 *
 * ## Topping up with bots
 *
 * If the survivors are short of a game and the game has Stupids, the shortfall
 * is filled rather than refusing the rematch — three friends who lost two
 * players should not be told to go back to the menu. Seats are filled to the
 * minimum, never to the old occupancy: a rematch is not an excuse to pack the
 * table with bots nobody asked for.
 */

/** How long an offer stands before it lapses. */
const REMATCH_WINDOW_MS = 30_000;

/** The offer as it travels on the wire. */
export interface RematchStateDto {
  open: boolean;
  requestedBy: string;
  deadlineAtMs: number;
  accepted: string[];
  declined: string[];
  /** Everybody still expected to answer. */
  pending: string[];
  outcome: 'open' | 'started' | 'failed' | 'cancelled';
  /** How many players this game needs, so a client can explain a failure. */
  minPlayers: number;
}

export class RematchService {
  /**
   * Timers for the open offers.
   *
   * Held rather than relying on a lazy check, because an offer nobody answers
   * still has to close: four players who all walk away from the screen must
   * not leave a room sitting open forever.
   */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** How many offers are standing. For the health probe. */
  activeOffers(): number {
    return this.timers.size;
  }

  /**
   * Opens an offer, or returns the one already standing.
   *
   * Returning rather than refusing is the duplicate protection: two players
   * tapping "Rematch" in the same second is the normal case, not an error, and
   * the second of them should see the first one's offer.
   */
  async request(gameId: GameId, roomId: string, userId: string): Promise<RematchStateDto> {
    const room = await this.requireRoom(gameId, roomId);
    this.requireSeat(room, userId);

    if (room.status === 'playing') {
      throw errors.gameAlreadyStarted('That match is still running.');
    }

    const open = room.rematch;
    if (open && open.outcome === 'open' && open.deadlineAtMs > Date.now()) {
      // Somebody beat them to it. Record the tap as an acceptance, which is
      // what the player meant by pressing the button.
      return this.respond(gameId, roomId, userId, true);
    }

    const now = Date.now();
    room.rematch = {
      requestedBy: userId,
      requestedAtMs: now,
      deadlineAtMs: now + REMATCH_WINDOW_MS,
      // Bots never decline. They are not being asked; they are furniture that
      // plays, and a table of one human and three Stupids should rematch on
      // one tap.
      accepted: [userId, ...room.players.filter((p) => p.isBot).map((p) => p.playerId)],
      declined: [],
      outcome: 'open',
    };
    await room.save();

    this.arm(gameId, roomId, REMATCH_WINDOW_MS);
    this.announce(gameId, roomId);

    // Nobody left to ask. A lone human, or a table whose only other seats are
    // Stupids, has already given the only answer there is — so it settles now
    // rather than sitting out a thirty-second window that cannot change.
    const outstanding = room.players.filter(
      (player) => !player.isBot && player.playerId !== userId,
    );
    if (outstanding.length === 0) {
      await this.settle(gameId, roomId);
      return this.stateFor(gameId, roomId);
    }

    return this.serialize(room);
  }

  /** Records a yes or a no, and starts the match if that was enough. */
  async respond(
    gameId: GameId,
    roomId: string,
    userId: string,
    accept: boolean,
  ): Promise<RematchStateDto> {
    const room = await this.requireRoom(gameId, roomId);
    this.requireSeat(room, userId);

    const offer = room.rematch;
    if (!offer || offer.outcome !== 'open') {
      throw errors.invalidAction('There is no rematch to answer.');
    }
    if (offer.deadlineAtMs <= Date.now()) {
      await this.close(gameId, roomId, 'failed');
      throw errors.invalidAction('That rematch offer has expired.');
    }

    // Idempotent: a double tap, or a reconnect replaying the answer, must not
    // count twice or flip a decision that was already made.
    offer.accepted = offer.accepted.filter((id) => id !== userId);
    offer.declined = offer.declined.filter((id) => id !== userId);
    if (accept) offer.accepted.push(userId);
    else offer.declined.push(userId);

    await room.save();

    if (!accept) {
      // Out of the room, not merely out of the offer. Leaving them seated is
      // exactly the trap this design exists to avoid, and it also frees the
      // seat for the bot top-up below.
      await gamePlatformService.leaveRoom(gameId, roomId, userId).catch(() => null);
      this.announce(gameId, roomId);
      return this.stateFor(gameId, roomId);
    }

    this.announce(gameId, roomId);

    // Everybody has answered, or enough have said yes to play. Either way
    // there is nothing left to wait for.
    const definition = gameDefinition(gameId);
    const stillToAnswer = room.players.filter(
      (player) => !player.isBot
        && !offer.accepted.includes(player.playerId)
        && !offer.declined.includes(player.playerId),
    );

    if (stillToAnswer.length === 0) {
      await this.settle(gameId, roomId);
    } else if (offer.accepted.length >= definition.maxPlayers) {
      await this.settle(gameId, roomId);
    }

    return this.stateFor(gameId, roomId);
  }

  /** Withdraws an offer without starting anything. */
  async cancel(gameId: GameId, roomId: string): Promise<void> {
    await this.close(gameId, roomId, 'cancelled');
  }

  /** The offer as it stands, for a client that has just reconnected. */
  async stateFor(gameId: GameId, roomId: string): Promise<RematchStateDto> {
    const room = await this.requireRoom(gameId, roomId);
    return this.serialize(room);
  }

  // ------------------------------------------------------------- internals --

  /**
   * Decides the offer: start, or report that it failed.
   *
   * The one place a rematch can begin, so the minimum-player rule and the bot
   * top-up cannot be bypassed by a race between the deadline and the last
   * acceptance.
   */
  private async settle(gameId: GameId, roomId: string): Promise<void> {
    const room = await this.requireRoom(gameId, roomId).catch(() => null);
    if (!room) return;

    const offer = room.rematch;
    if (!offer || offer.outcome !== 'open') return;

    this.disarm(roomId);

    const accepted = new Set(offer.accepted);
    // Anybody who neither accepted nor declined has let it lapse. They keep
    // their seat — they may simply have been backgrounded — but they are not
    // dealt into a match they never agreed to.
    room.players = room.players.filter(
      (player) => player.isBot || accepted.has(player.playerId),
    ) as typeof room.players;

    const definition = gameDefinition(gameId);
    const humans = room.players.filter((player) => !player.isBot).length;

    if (humans === 0) {
      // Everybody left. A table of nothing but Stupids is not a match.
      offer.outcome = 'failed';
      room.status = 'closed';
      room.closedAt = new Date();
      await room.save();
      this.announce(gameId, roomId);
      return;
    }

    // Reset the seats before any top-up, so the count below is honest.
    for (const player of room.players) player.isReady = true;
    room.matchId = null;
    room.status = 'waiting';
    offer.outcome = 'started';
    await room.save();

    if (room.players.length < definition.minPlayers && definition.supportsBots) {
      // Short of a game. Fill to the minimum and no further.
      await gamePlatformService
        .addStupids({
          gameId,
          roomId,
          actorId: String(room.ownerId),
          count: definition.minPlayers - room.players.length,
          difficulty: BOT_DIFFICULTY.normal,
        })
        .catch((error: unknown) => {
          logger.warn('rematch bot top-up failed', { roomId, error: String(error) });
        });
    }

    const fresh = await this.requireRoom(gameId, roomId).catch(() => null);
    if (!fresh) return;

    if (fresh.players.length < definition.minPlayers) {
      fresh.rematch = { ...offer, outcome: 'failed' };
      fresh.status = 'completed';
      await fresh.save();
      this.announce(gameId, roomId);
      return;
    }

    try {
      // Straight into the match. Everybody in this room has explicitly said
      // yes, so there is no second ready-up to wait for.
      await gamePlatformService.startRoom(fresh);
      this.announce(gameId, roomId, 'game:match_started');
    } catch (error: unknown) {
      logger.exception('starting a rematch failed', error, { roomId });
      fresh.rematch = { ...offer, outcome: 'failed' };
      fresh.status = 'completed';
      await fresh.save();
      this.announce(gameId, roomId);
    }
  }

  /** Closes an offer without starting, and tells the room. */
  private async close(
    gameId: GameId,
    roomId: string,
    outcome: 'failed' | 'cancelled',
  ): Promise<void> {
    this.disarm(roomId);

    const room = await this.requireRoom(gameId, roomId).catch(() => null);
    if (!room?.rematch || room.rematch.outcome !== 'open') return;

    room.rematch.outcome = outcome;
    await room.save();
    this.announce(gameId, roomId);
  }

  /**
   * Starts the deadline.
   *
   * On expiry it *settles* rather than failing outright: three of five saying
   * yes inside the window is a perfectly good rematch, and refusing it because
   * two people never looked at their phones would be the wrong answer.
   */
  private arm(gameId: GameId, roomId: string, delayMs: number): void {
    this.disarm(roomId);
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      void this.settle(gameId, roomId).catch((error: unknown) => {
        logger.exception('settling a lapsed rematch failed', error, { roomId });
      });
    }, delayMs);
    timer.unref?.();
    this.timers.set(roomId, timer);
  }

  private disarm(roomId: string): void {
    const timer = this.timers.get(roomId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(roomId);
  }

  private announce(gameId: GameId, roomId: string, event = 'game:room_updated'): void {
    gamePlatformService.notifyRoom(gameId, roomId, event);
  }

  private async requireRoom(gameId: GameId, roomId: string): Promise<GameRoomHydrated> {
    const room = await GameRoom.findById(roomId);
    if (!room || String(room.gameId) !== gameId) throw errors.roomNotFound();
    return room;
  }

  private requireSeat(room: GameRoomHydrated, userId: string): void {
    if (!room.players.some((player) => player.playerId === userId)) {
      throw errors.notInGame();
    }
  }

  private serialize(room: GameRoomHydrated): RematchStateDto {
    const offer = room.rematch;
    const definition = gameDefinition(room.gameId as GameId);

    if (!offer) {
      return {
        open: false,
        requestedBy: '',
        deadlineAtMs: 0,
        accepted: [],
        declined: [],
        pending: [],
        outcome: 'cancelled',
        minPlayers: definition.minPlayers,
      };
    }

    const answered = new Set<string>([...offer.accepted, ...offer.declined]);

    return {
      open: offer.outcome === 'open' && offer.deadlineAtMs > Date.now(),
      requestedBy: offer.requestedBy,
      deadlineAtMs: offer.deadlineAtMs,
      accepted: [...offer.accepted],
      declined: [...offer.declined],
      pending: room.players
        .filter((player) => !player.isBot && !answered.has(player.playerId))
        .map((player) => player.playerId),
      outcome: offer.outcome as RematchStateDto['outcome'],
      minPlayers: definition.minPlayers,
    };
  }
}

export const rematchService = new RematchService();
