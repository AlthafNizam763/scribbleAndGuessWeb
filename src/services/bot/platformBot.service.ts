import type { BotDifficultyWire } from '@/constants/autoTournament.constants';
import { personalityFor } from '@/games/botPersonalities';
import { gameAdapters } from '@/games/adapters';
import type { GameId } from '@/games/game.types';
import { logger } from '@/utils/logger';

type State = Record<string, unknown>;

/** What the driver needs from the platform engine, and nothing more. */
export interface PlatformBotEngine {
  /** The match as one seat sees it — the same projection a person is sent. */
  matchForViewer(gameId: GameId, matchId: string, viewerId: string): Promise<State>;

  /** Applies an action through the ordinary, validated path. */
  action(gameId: GameId, matchId: string, userId: string, action: State): Promise<State>;

  /**
   * Who is sitting in the room this match belongs to.
   *
   * `botDifficulty` rides along because it is the seat's property and not the
   * character's: the same Smug Dave is a different opponent depending on the
   * dial the host chose, and the brain cannot know which without being told.
   */
  seats(roomId: string): Promise<{
    playerId: string;
    isBot: boolean;
    botId: string | null;
    botDifficulty: BotDifficultyWire | null;
  }[]>;
}

/**
 * Stupids, playing the platform games.
 *
 * ## One reconciler, and no second engine
 *
 * `reconcile` is called after every state change the platform service makes —
 * a match starting, an action landing — which is the single funnel those
 * already pass through. Hanging the bots there means there is no list of call
 * sites each having to remember to notify them, the same reasoning that put
 * Scribble's `botPlayerService.reconcile` inside `broadcastState`.
 *
 * It is also what makes a room with no Stupids cost nothing: the first thing
 * it does is look at whose turn it is, and an ordinary room returns before
 * anything else happens.
 *
 * ## Bots act through the engine, never around it
 *
 * A Stupid's move goes back through `gamePlatformService.action`, which checks
 * it is that seat's turn and that the move is legal, exactly as it does for a
 * person. There is no turn-advancing path, no scoring path and no state write
 * that exists only for bots — which is what "do not build a second game
 * engine" means here, and it is also why a Stupid cannot cheat: it is subject
 * to every rule because it is going through every rule.
 *
 * What it is allowed to *see* is bounded the same way. The adapter is handed
 * `matchForViewer(..., botId)` — the bot's own projection — so it cannot read
 * another hand or the donkey's location, because neither is in the object.
 *
 * ## Why the turn is taken on a timer
 *
 * Two reasons, and the second is the important one. A Stupid that answered
 * instantly would feel like a script rather than a player. And taking the turn
 * inside the call that triggered it would recurse — bot moves, which
 * reconciles, which moves the next bot — until a room of four Stupids blew the
 * stack. A `setTimeout` breaks that: each turn starts from a fresh tick.
 *
 * ## Task lifetime
 *
 * One pending turn per room, held in a map, replaced rather than stacked. A
 * match that ends, a room that closes and a player who leaves all clear it,
 * because a timer that fires into a finished match is how a board ends up with
 * a move nobody made.
 */
export class PlatformBotService {
  private engine: PlatformBotEngine | null = null;

  /**
   * The pending turn per room.
   *
   * Keyed by room rather than by bot: only one seat can be on turn at a time,
   * so a second pending turn in the same room is always either a duplicate or
   * a stale one, and both should replace rather than accumulate.
   */
  private readonly pending = new Map<string, NodeJS.Timeout>();

  /**
   * Hands the engine over at boot.
   *
   * Injected rather than imported because `game_platform.service.ts` imports
   * this module to call `reconcile`; importing it back would form a cycle
   * whose behaviour depends on which one Node happens to load first.
   */
  bindEngine(engine: PlatformBotEngine): void {
    this.engine = engine;
  }

  /**
   * Schedules a Stupid's turn, if it is a Stupid's turn.
   *
   * Cheap and safe to call after any state change. Returns without scheduling
   * when the match is over, when the seat on turn is a person, or when the
   * game has no bot implementation at all.
   */
  reconcile(input: {
    gameId: GameId;
    roomId: string;
    matchId: string;
    status: string;
    turnUserId: string | null;
  }): void {
    const { gameId, roomId, matchId, status, turnUserId } = input;

    if (status !== 'playing' || !turnUserId) {
      this.clearRoom(roomId);
      return;
    }

    // A game whose adapter has no bot brain never schedules anything, so a
    // Space Mystery room full of people costs one property lookup.
    if (!gameAdapters[gameId]) return;

    void this.scheduleIfBot({ gameId, roomId, matchId, turnUserId });
  }

  /** Drops any pending turn for a room. */
  clearRoom(roomId: string): void {
    const timer = this.pending.get(roomId);
    if (!timer) return;
    clearTimeout(timer);
    this.pending.delete(roomId);
  }

  /** How many rooms are currently waiting on a Stupid. For the health probe. */
  activeWorkers(): number {
    return this.pending.size;
  }

  private async scheduleIfBot(input: {
    gameId: GameId;
    roomId: string;
    matchId: string;
    turnUserId: string;
  }): Promise<void> {
    const engine = this.engine;
    if (!engine) return;

    try {
      const seats = await engine.seats(input.roomId);
      const seat = seats.find((candidate) => candidate.playerId === input.turnUserId);
      if (!seat?.isBot) {
        // A person is on turn; nothing to do, and any timer still holding from
        // the previous seat is stale.
        this.clearRoom(input.roomId);
        return;
      }

      const personality = personalityFor(seat.botId ?? '', seat.botDifficulty);

      // Replaces rather than stacks: see `pending`.
      this.clearRoom(input.roomId);
      this.pending.set(
        input.roomId,
        setTimeout(() => {
          this.pending.delete(input.roomId);
          void this.takeTurn({ ...input, botId: seat.playerId, personality });
        }, jitter(personality.thinkMs)),
      );
    } catch (error: unknown) {
      logger.exception('scheduling a Stupid turn failed', error, {
        roomId: input.roomId,
        matchId: input.matchId,
      });
    }
  }

  private async takeTurn(input: {
    gameId: GameId;
    roomId: string;
    matchId: string;
    botId: string;
    personality: ReturnType<typeof personalityFor>;
  }): Promise<void> {
    const engine = this.engine;
    if (!engine) return;

    try {
      // The bot's own projection, which is the whole of what it may know:
      // `matchForViewer` returns an envelope whose `state` is exactly what
      // `getPrivatePlayerState` produced for this seat.
      const view = await engine.matchForViewer(input.gameId, input.matchId, input.botId);
      const seen = asState(view.state);

      const adapter = gameAdapters[input.gameId];
      const action = adapter.suggestBotAction?.(seen, input.botId, input.personality) ?? null;

      if (!action) {
        // Nothing legal to do. Not an error — the engine passes the turn on by
        // itself in the cases this happens in — but worth a line, because a
        // recurring one means a bot that cannot play a position it is given.
        logger.info('a Stupid had no move', {
          roomId: input.roomId,
          botId: input.botId,
          gameId: input.gameId,
        });
        return;
      }

      const next = await engine.action(input.gameId, input.matchId, input.botId, action);

      // The move may have left the turn with another Stupid — a room can be
      // all bots but one — so the cycle continues from the state it produced.
      this.reconcile({
        gameId: input.gameId,
        roomId: input.roomId,
        matchId: input.matchId,
        status: typeof next.status === 'string' ? next.status : 'playing',
        turnUserId: turnUserIdOf(next),
      });
    } catch (error: unknown) {
      // A refused or failed bot move must never take the match down with it.
      // The turn simply does not happen; a person can still act, and the next
      // state change reconciles again.
      logger.exception('a Stupid turn failed', error, {
        roomId: input.roomId,
        botId: input.botId,
        gameId: input.gameId,
      });
    }
  }
}

/**
 * Spreads the think time so two Stupids never answer in lockstep.
 *
 * ±30%, which is enough that a room of four does not feel like a metronome
 * and not so much that the slow ones stop reading as slow.
 */
function jitter(baseMs: number): number {
  const spread = baseMs * 0.3;
  return Math.max(200, Math.round(baseMs - spread + Math.random() * spread * 2));
}

function asState(value: unknown): State {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as State)
    : {};
}

/**
 * The seat on turn, read from a `matchForViewer` envelope.
 *
 * The turn holder lives inside the adapter's projection as `currentPlayerId`,
 * because who is on turn is a fact about the game rather than about the
 * envelope carrying it.
 */
function turnUserIdOf(envelope: State): string | null {
  const view = asState(envelope.state);
  return typeof view.currentPlayerId === 'string' ? view.currentPlayerId : null;
}

export const platformBotService = new PlatformBotService();
