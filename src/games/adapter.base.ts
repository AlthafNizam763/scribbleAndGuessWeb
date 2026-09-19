import { randomInt } from 'node:crypto';

import type { BotPersonality, GameAdapter, GameId, PlatformPlayerState } from '@/games/game.types';
import { errors } from '@/utils/errors';

/**
 * The mechanics every adapter shares: turn order, projections, and the shape
 * of a state document.
 *
 * Extracted from `adapters.ts` once the card and deduction games outgrew a
 * single file. `adapters.ts` remains the registry — the one place that says
 * which class serves which game id — and each ruleset now lives next to its
 * own helpers rather than a thousand lines from them.
 */

export type State = Record<string, unknown>;
export type Hands = Record<string, string[]>;
export type NumberMap = Record<string, number>;

export function ids(players: PlatformPlayerState[]): string[] {
  return players.map((player) => player.playerId);
}

export function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const target = randomInt(index + 1);
    const value = copy[index];
    copy[index] = copy[target]!;
    copy[target] = value!;
  }
  return copy;
}

export function record(value: unknown): State {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as State
    : {};
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function turn(state: State): string | null {
  const order = strings(state.order);
  const index = typeof state.turnIndex === 'number' ? state.turnIndex : 0;
  return order[index] ?? null;
}

export function requireTurn(state: State, playerId: string): void {
  if (state.status !== 'playing') throw errors.gameNotStarted();
  if (turn(state) !== playerId) throw errors.invalidAction('It is not your turn.');
}

/**
 * Whether this Stupid is about to do something daft on purpose.
 *
 * The one call every `suggestBotAction` makes before it starts thinking. Drawn
 * per decision rather than per match, so a bot is unpredictable within a game
 * instead of being a good one or a bad one for its whole life.
 */
export function blunders(personality: { blunderChance: number }): boolean {
  return randomInt(1000) < Math.round(personality.blunderChance * 1000);
}

/**
 * Whether this Stupid noticed something it could have noticed.
 *
 * The `read` counterpart to [blunders], and the reason difficulty is more than
 * a blunder rate. Called at the point a bot is about to *use* a fact its own
 * projection carries — how many cards somebody has played, who walked out of
 * the reactor — so an inattentive bot plays on without it rather than playing
 * the same move slightly worse.
 */
export function notices(personality: { read: number }): boolean {
  return randomInt(1000) < Math.round(personality.read * 1000);
}

/** A uniformly random element. Callers guarantee a non-empty list. */
export function pick<T>(items: readonly T[]): T {
  return items[randomInt(items.length)]!;
}

/** The `{playerId, cardCount}` rows a card game's public projection carries. */
export function asSeats(value: unknown): { playerId: string; cardCount: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const seat = record(row);
    return typeof seat.playerId === 'string'
      ? [{ playerId: seat.playerId, cardCount: Number(seat.cardCount) || 0 }]
      : [];
  });
}

export function nextTurn(state: State): void {
  const order = strings(state.order);
  if (order.length === 0) return;
  const current = typeof state.turnIndex === 'number' ? state.turnIndex : 0;
  state.turnIndex = (current + 1) % order.length;
}

/**
 * Shared adapter mechanics.  Every adapter stores private data only in its
 * server state and exposes an explicit projection, so adding a response
 * endpoint cannot accidentally stringify a whole match document.
 */
export abstract class BaseAdapter implements GameAdapter {
  abstract readonly gameId: GameId;

  /** Turn-based unless a subclass says otherwise. Four of the five are. */
  readonly realtime: boolean = false;

  createMatch(players: PlatformPlayerState[]): State {
    return { status: 'waiting', order: shuffled(ids(players)), turnIndex: 0, players: ids(players) };
  }
  joinMatch(state: State): State { return state; }
  leaveMatch(state: State, playerId: string): State {
    state.order = strings(state.order).filter((id) => id !== playerId);
    state.players = strings(state.players).filter((id) => id !== playerId);
    if (turn(state) === null) state.status = 'completed';
    return state;
  }
  readyPlayer(state: State): State { return state; }
  startMatch(state: State): State { state.status = 'playing'; return state; }
  abstract handlePlayerAction(state: State, playerId: string, action: State): State;
  abstract validateAction(state: State, playerId: string, action: State): void;
  updateGameState(state: State): State { return state; }
  calculateScore(state: State): NumberMap { return record(state.scores) as NumberMap; }
  completeMatch(state: State): State { state.status = 'completed'; return state; }
  abstract getPublicState(state: State): State;
  abstract getPrivatePlayerState(state: State, playerId: string): State;
  reconnectPlayer(state: State): State { return state; }
  getResult(state: State): State | null { return state.status === 'completed' ? record(state.result) : null; }

  /**
   * No bot, unless a subclass says otherwise.
   *
   * Every game in the catalogue now overrides this — the three that did not
   * are the subject of this work — but the default stays, because it is the
   * honest answer for a ruleset added later whose bot has not been written
   * yet: no Stupids, rather than a Stupid that stalls the match.
   */
  suggestBotAction(_view: State, _botId: string, _personality: BotPersonality): State | null {
    return null;
  }
}
