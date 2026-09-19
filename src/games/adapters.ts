import { randomInt } from 'node:crypto';

import {
  BaseAdapter, blunders, nextTurn, pick, record, requireTurn, shuffled, strings, turn,
  type NumberMap, type State,
} from '@/games/adapter.base';
import { BluffBarGameAdapter } from '@/games/bluffBar.adapter';
import type { BotPersonality, GameAdapter, GameId, PlatformPlayerState } from '@/games/game.types';
import { KazhuthaGameAdapter } from '@/games/kazhutha.adapter';
import { SpaceMysteryGameAdapter } from '@/games/spaceMystery.adapter';
import { errors } from '@/utils/errors';

/**
 * The registry: which class serves which game id.
 *
 * This file used to be all five rulesets in one place. Three of them — the two
 * card games and the deduction game — outgrew that when they stopped being
 * sketches, and each now lives next to its own helpers, its own deck and, in
 * one case, its own simulation. What is left here is Ludo, which is small and
 * self-contained, the Scribble bridge, which is four methods that refuse, and
 * the table at the bottom that names them all.
 *
 * Types and shared turn mechanics moved to `adapter.base.ts`, so an adapter in
 * any of these files behaves identically to one in any other.
 */

type Positions = Record<string, number[]>;

/** The `{playerId, cardCount}` rows a card game's public projection carries. */
function asSeats(value: unknown): { playerId: string; cardCount: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const seat = record(row);
    return typeof seat.playerId === 'string'
      ? [{ playerId: seat.playerId, cardCount: Number(seat.cardCount) || 0 }]
      : [];
  });
}

function ids(players: PlatformPlayerState[]): string[] {
  return players.map((player) => player.playerId);
}

/** Existing drawing engine remains authoritative; this adapter is its catalogue bridge. */
export class ScribbleGuessGameAdapter extends BaseAdapter {
  readonly gameId = 'SCRIBBLE_GUESS' as const;

  createMatch(players: PlatformPlayerState[]): State {
    return { ...super.createMatch(players), engine: 'scribble-v1', status: 'delegated' };
  }
  validateAction(): void {
    throw errors.invalidAction('Scribble & Guess actions use the established drawing engine.');
  }
  handlePlayerAction(state: State): State { return state; }
  getPublicState(state: State): State {
    return { gameId: this.gameId, status: state.status, engine: 'existing-scribble-engine' };
  }
  getPrivatePlayerState(state: State): State { return this.getPublicState(state); }
}

/** Server-authoritative Ludo: random dice, legal movement, safe squares and captures. */
export class LudoGameAdapter extends BaseAdapter {
  readonly gameId = 'LUDO' as const;

  override createMatch(players: PlatformPlayerState[]): State {
    const state = super.createMatch(players);
    return {
      ...state, status: 'waiting', positions: Object.fromEntries(ids(players).map((id) => [id, [-1, -1, -1, -1]])),
      dice: null, consecutiveSixes: 0, finished: [], scores: {}, lastMove: null,
    };
  }
  override startMatch(state: State): State { state.status = 'playing'; return state; }

  validateAction(state: State, playerId: string, action: State): void {
    requireTurn(state, playerId);
    if (action.type === 'roll') {
      if (typeof state.dice === 'number') throw errors.invalidAction('Move a token before rolling again.');
      return;
    }
    if (action.type !== 'move') throw errors.validation('Unsupported Ludo action.');
    const token = typeof action.tokenIndex === 'number' ? action.tokenIndex : -1;
    const dice = typeof state.dice === 'number' ? state.dice : 0;
    const positions = (record(state.positions) as Positions)[playerId] ?? [];
    if (token < 0 || token >= positions.length || !canMove(positions[token]!, dice)) throw errors.invalidAction('That token cannot move with this roll.');
  }

  handlePlayerAction(state: State, playerId: string, action: State): State {
    this.validateAction(state, playerId, action);
    if (action.type === 'roll') {
      const dice = randomInt(1, 7);
      state.dice = dice;
      state.lastRoll = { playerId, dice, atMs: Date.now() };
      const positions = (record(state.positions) as Positions)[playerId] ?? [];
      if (!positions.some((position) => canMove(position, dice))) {
        state.dice = null; nextTurn(state);
      }
      return state;
    }
    const positions = record(state.positions) as Positions;
    const dice = state.dice as number;
    const tokenIndex = action.tokenIndex as number;
    const before = positions[playerId]![tokenIndex]!;
    const after = before === -1 ? 0 : before + dice;
    positions[playerId]![tokenIndex] = after;
    const captured = captureTokens(state, playerId, after);
    state.lastMove = { playerId, tokenIndex, from: before, to: after, captured, atMs: Date.now() };
    state.dice = null;
    const complete = positions[playerId]!.filter((position) => position === 56).length;
    if (complete === 4) {
      state.status = 'completed'; state.result = { winnerId: playerId, reason: 'all_tokens_home' }; return state;
    }
    if (dice !== 6) nextTurn(state);
    return state;
  }

  getPublicState(state: State): State {
    return {
      gameId: this.gameId, status: state.status, currentPlayerId: turn(state), dice: state.dice,
      order: strings(state.order),
      positions: record(state.positions), lastRoll: state.lastRoll, lastMove: state.lastMove, result: state.result ?? null,
    };
  }
  getPrivatePlayerState(state: State): State { return this.getPublicState(state); }

  /**
   * Rolls, or chooses a token to move.
   *
   * Ludo hides nothing — every position is on the board — so the view this
   * gets is the public state, and a bot here has exactly the information a
   * person staring at the board does. It still has to go through the engine:
   * the dice are the server's, and asking to move a token the roll cannot
   * reach is refused like anybody else's.
   *
   * Ranked rather than searched. A real Ludo engine would look ahead; this one
   * scores each legal move on four things a person would actually notice, and
   * then throws the ranking away entirely `blunderChance` of the time.
   */
  override suggestBotAction(
    view: State,
    botId: string,
    personality: BotPersonality,
  ): State | null {
    if (view.status !== 'playing' || view.currentPlayerId !== botId) return null;

    // No dice on the table means the turn has not started.
    const dice = typeof view.dice === 'number' ? view.dice : null;
    if (dice === null) return { type: 'roll' };

    const mine = (record(view.positions) as Positions)[botId] ?? [];
    const legal: number[] = [];
    for (let index = 0; index < mine.length; index++) {
      if (canMove(mine[index]!, dice)) legal.push(index);
    }

    // The engine passes the turn on automatically when nothing can move, so
    // this is only reachable in a state that should not occur — return null
    // rather than sending an action certain to be refused.
    if (legal.length === 0) return null;

    if (blunders(personality)) {
      return { type: 'move', tokenIndex: pick(legal) };
    }

    const scored = legal
      .map((tokenIndex) => ({
        tokenIndex,
        score: scoreLudoMove(view, botId, tokenIndex, mine[tokenIndex]!, dice, personality),
      }))
      .sort((a, b) => b.score - a.score);

    return { type: 'move', tokenIndex: scored[0]!.tokenIndex };
  }
}

/**
 * How much a Stupid likes one token move, in arbitrary points.
 *
 * Four considerations, in the order a person would weigh them. `boldness`
 * scales only the capture term, which is what makes Smug Dave chase captures
 * across the board while Nervous Nancy shuffles tokens toward home and never
 * looks up.
 */
function scoreLudoMove(
  view: State,
  botId: string,
  tokenIndex: number,
  from: number,
  dice: number,
  personality: BotPersonality,
): number {
  const to = from === -1 ? 0 : from + dice;
  let score = 0;

  // Getting a token out is nearly always right, and it is the only thing a six
  // can do for a token still in the yard.
  if (from === -1) score += 40;

  // Landing exactly home is worth more than any amount of board position.
  if (to === 56) score += 60;

  // Captures. Scaled by boldness, because whether this is the best move
  // depends on temperament as much as on the board.
  const captures = wouldCapture(view, botId, to);
  score += captures * 50 * personality.boldness;

  // A safe square cannot be captured on, so ending a move on one is worth
  // something to everybody — more to the timid.
  if (isSafeSquare(to)) score += 15 * (1.2 - personality.boldness);

  // All else equal, prefer the token furthest along: it is the one closest to
  // being out of reach.
  score += to * 0.2;

  return score;
}

/** How many opponent tokens a move onto [position] would send home. */
function wouldCapture(view: State, moverId: string, position: number): number {
  if (position < 0 || position >= 52 || isSafeSquare(position)) return 0;

  const order = strings(view.order);
  const moverStart = (order.indexOf(moverId) * 13) % 52;
  const boardCell = (moverStart + position) % 52;
  const positions = record(view.positions) as Positions;

  let captured = 0;
  for (const opponentId of order) {
    if (opponentId === moverId) continue;
    const opponentStart = (order.indexOf(opponentId) * 13) % 52;
    for (const theirPosition of positions[opponentId] ?? []) {
      if (theirPosition < 0 || theirPosition >= 52) continue;
      if ((opponentStart + theirPosition) % 52 === boardCell) captured++;
    }
  }
  return captured;
}

/**
 * The squares a token cannot be captured on.
 *
 * Shared with `captureTokens`, which is the authority — a bot that disagreed
 * with the engine about safety would be scoring moves against a board that
 * does not exist.
 */
const SAFE_SQUARES: readonly number[] = [0, 8, 13, 21, 26, 34, 39, 47];

function isSafeSquare(position: number): boolean {
  return position >= 52 || SAFE_SQUARES.includes(position);
}

function canMove(position: number, dice: number): boolean {
  if (dice < 1 || dice > 6 || position === 56) return false;
  return position === -1 ? dice === 6 : position + dice <= 56;
}

function captureTokens(state: State, moverId: string, position: number): string[] {
  // Home paths are private after 52; start squares and the safe squares cannot
  // be captured on. Shared with the bot's move scorer, which would otherwise be
  // ranking captures against a board that does not exist.
  if (position < 0 || position >= 52 || SAFE_SQUARES.includes(position)) return [];
  const order = strings(state.order);
  const moverStart = (order.indexOf(moverId) * 13) % 52;
  const boardCell = (moverStart + position) % 52;
  const positions = record(state.positions) as Positions;
  const captured: string[] = [];
  for (const opponentId of order) {
    if (opponentId === moverId) continue;
    const opponentStart = (order.indexOf(opponentId) * 13) % 52;
    for (let index = 0; index < (positions[opponentId]?.length ?? 0); index++) {
      const theirPosition = positions[opponentId]![index]!;
      if (theirPosition >= 0 && theirPosition < 52 && (opponentStart + theirPosition) % 52 === boardCell) {
        positions[opponentId]![index] = -1; captured.push(opponentId);
      }
    }
  }
  return captured;
}

export const gameAdapters: Readonly<Record<GameId, GameAdapter>> = {
  SCRIBBLE_GUESS: new ScribbleGuessGameAdapter(),
  KAZHUTHA: new KazhuthaGameAdapter(),
  BLUFF_BAR: new BluffBarGameAdapter(),
  SPACE_MYSTERY: new SpaceMysteryGameAdapter(),
  LUDO: new LudoGameAdapter(),
};
