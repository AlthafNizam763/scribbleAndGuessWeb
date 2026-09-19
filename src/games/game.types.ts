import type { BotDifficultyWire } from '@/constants/autoTournament.constants';

/**
 * The platform catalogue is deliberately an application constant, not a
 * client-owned list.  A client can choose a game id, never its player limits,
 * bot policy or route.
 */
export const GAME_IDS = [
  'SCRIBBLE_GUESS',
  'KAZHUTHA',
  'BLUFF_BAR',
  'SPACE_MYSTERY',
  'LUDO',
] as const;

export type GameId = (typeof GAME_IDS)[number];
export type GameAvailability = 'live' | 'coming_soon';
export type PlatformRoomStatus = 'waiting' | 'playing' | 'completed' | 'closed';
export type PlatformMatchStatus = 'waiting' | 'playing' | 'completed' | 'cancelled';

export interface GameDefinitionDto {
  gameId: GameId;
  displayName: string;
  description: string;
  icon: string;
  banner: string;
  minPlayers: number;
  maxPlayers: number;
  supportsBots: boolean;
  supportsVoice: boolean;
  supportsTextChat: boolean;
  route: string;
  status: GameAvailability;
  version: number;
  rules: readonly string[];
}

/** A durable generic seat. Bots have no user id and are never rewarded. */
export interface PlatformPlayerState {
  playerId: string;
  userId: string | null;
  username: string;
  avatarId: number;
  avatarColorIndex: number;
  isBot: boolean;
  botDifficulty: BotDifficultyWire | null;
  isReady: boolean;
  connected: boolean;
  joinedAtMs: number;
}

export interface PlatformRoomState {
  roomId: string;
  roomCode: string;
  gameId: GameId;
  ownerId: string;
  status: PlatformRoomStatus;
  isPrivate: boolean;
  maxPlayers: number;
  players: PlatformPlayerState[];
  matchId: string | null;
  createdAtMs: number;

  /**
   * The standing offer to play this table again, or null.
   *
   * On the room because that is what it is a property of — there can only be
   * one open at a time, it dies with the room, and a client that reconnects
   * needs the room and the offer in the same payload rather than in two.
   */
  rematch: {
    open: boolean;
    requestedBy: string;
    deadlineAtMs: number;
    accepted: string[];
    declined: string[];
    outcome: string;
  } | null;
}

export interface PlatformMatchState {
  matchId: string;
  roomId: string;
  gameId: GameId;
  status: PlatformMatchStatus;
  turnUserId: string | null;
  publicState: Record<string, unknown>;
  result: Record<string, unknown> | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
}

/**
 * How one Stupid plays, as a handful of dials.
 *
 * Deliberately not a difficulty level. A "hard" bot and an "easy" bot that
 * differ only in how often they blunder are the same character twice, and this
 * platform's bots are supposed to be *recognisable* — somebody should notice
 * that Smug Dave always goes for the throat and that Big Yawn never does.
 *
 * Every dial narrows a choice the adapter has already decided is legal. None
 * of them can produce an illegal move, because none of them reaches the rules:
 * the adapter picks from the moves it generated, and the engine validates the
 * result anyway.
 */
export interface BotPersonality {
  /** Stable key, matching the roster in `autoTournament.constants`. */
  botId: string;

  /**
   * How often this one takes a random legal move instead of its best.
   *
   * The whole point of the product, mechanically. Zero would be a bot that
   * never does anything funny; one would be a bot indistinguishable from
   * noise. Everything ships between.
   */
  blunderChance: number;

  /**
   * How much it prefers the aggressive option when both are legal.
   *
   * Ludo: taking a capture rather than running a token to safety. Kazhutha:
   * drawing from the player holding most cards rather than fewest.
   */
  boldness: number;

  /** Roughly how long it sits there before acting, in milliseconds. */
  thinkMs: number;

  /**
   * How much of the evidence actually on the table this one uses, 0 to 1.
   *
   * Separate from [blunderChance] because the two fail differently, and the
   * bluffing and deduction games need both. A blunder is a bot that knew
   * better and did something daft anyway; a low `read` is a bot that never
   * worked it out — it did not count what had been played, it did not notice
   * who walked out of the reactor. One is funny, the other is beatable, and a
   * difficulty setting wants the second.
   *
   * Nothing it scales is hidden. `read` weights facts the seat's own
   * projection already carries, so a `read` of 1 is an attentive player and
   * never an informed one.
   */
  read: number;

  /**
   * Which difficulty this seat was seated at.
   *
   * Carried rather than folded entirely into the dials because some of the
   * difference is a behaviour and not a degree — an easy saboteur does not
   * wait for a witness-free corridor badly, it does not wait at all — and an
   * adapter needs to be able to ask.
   */
  difficulty: BotDifficultyWire;
}

/** The exact seam every game-specific authoritative rules engine implements. */
export interface GameAdapter {
  readonly gameId: GameId;

  /**
   * Whether this game is driven by a clock rather than by turns.
   *
   * Four of the five are turn-based: an action arrives, the state document is
   * folded and saved, and nothing happens in between. Space Mystery is not —
   * ten people walking around a ship change the world twenty times a second
   * whether or not anybody pressed anything, and persisting that would be a
   * database write per player per hundred milliseconds for a position that is
   * meaningless four frames later.
   *
   * So a real-time game keeps its live state in memory and touches the durable
   * record only at the moments that matter. This flag is what lets the generic
   * machinery know that without branching on a game id: the socket layer sends
   * its actions elsewhere, and the turn-based bot driver leaves it alone.
   */
  readonly realtime?: boolean;

  /**
   * Called once the platform has created the match document.
   *
   * The seam a real-time game starts its simulation on. After the document,
   * because a simulation is keyed on a match id and there is no id before it.
   * Turn-based adapters do not implement it.
   */
  onMatchStarted?(input: { matchId: string; roomId: string; players: PlatformPlayerState[] }): void;

  /** Called when the match is over or its room has closed. Free the clock. */
  onMatchEnded?(matchId: string): void;

  createMatch(players: PlatformPlayerState[]): Record<string, unknown>;
  joinMatch(state: Record<string, unknown>, player: PlatformPlayerState): Record<string, unknown>;
  leaveMatch(state: Record<string, unknown>, playerId: string): Record<string, unknown>;
  readyPlayer(state: Record<string, unknown>, playerId: string, ready: boolean): Record<string, unknown>;
  startMatch(state: Record<string, unknown>): Record<string, unknown>;
  handlePlayerAction(
    state: Record<string, unknown>,
    playerId: string,
    action: Record<string, unknown>,
  ): Record<string, unknown>;
  validateAction(state: Record<string, unknown>, playerId: string, action: Record<string, unknown>): void;
  updateGameState(state: Record<string, unknown>): Record<string, unknown>;
  calculateScore(state: Record<string, unknown>): Record<string, number>;
  completeMatch(state: Record<string, unknown>): Record<string, unknown>;
  getPublicState(state: Record<string, unknown>): Record<string, unknown>;
  getPrivatePlayerState(state: Record<string, unknown>, playerId: string): Record<string, unknown>;
  reconnectPlayer(state: Record<string, unknown>, playerId: string): Record<string, unknown>;
  getResult(state: Record<string, unknown>): Record<string, unknown> | null;

  /**
   * Chooses a legal action for a bot, or null when it has nothing to do.
   *
   * ## Why this takes a *view* and not the state
   *
   * `view` is exactly what `getPrivatePlayerState` returns for this bot — the
   * same projection a person in that seat is sent. That is not a convention,
   * it is the anti-cheat: a bot cannot peek at the donkey, at another hand or
   * at who the saboteur is, because those are not in the object it is handed.
   * An adapter that reached for the raw state here would be the one place in
   * the system where a bot knows more than a player, so it does not get one.
   *
   * ## Why the result is still validated
   *
   * The action returned here goes back through `handlePlayerAction`, which
   * calls `validateAction` exactly as it does for a person. Nothing here is
   * trusted; this only decides *what to try*. A bug in a suggestion is a
   * refused action, never a broken rule.
   *
   * Optional. An adapter without one simply has no bots — which is the honest
   * state for a game whose turn structure or hidden information makes a
   * plausible opponent a research project rather than a feature.
   */
  suggestBotAction?(
    view: Record<string, unknown>,
    botId: string,
    personality: BotPersonality,
  ): Record<string, unknown> | null;
}

export function isGameId(value: string): value is GameId {
  return (GAME_IDS as readonly string[]).includes(value);
}
