import { ROOM_DEFAULTS } from '@/constants/game.constants';

/**
 * The game modes, as a table of rules rather than as branches in the engine.
 *
 * ## Why this is data
 *
 * Nine modes implemented as nine code paths through `game.service.ts` would be
 * nine chances for the word to leak, nine places the timer could be wrong, and
 * a tenth mode would touch all of them. Instead every mode is a set of
 * *parameters the engine already reads* — a drawing time, a hint count, a
 * difficulty, a score multiplier — plus a small, closed set of genuine
 * behaviour flags for the handful of things a parameter cannot express.
 *
 * The engine asks this table what the rules are. It never asks which mode it
 * is in.
 *
 * ## The flags, and why each one has to be a flag
 *
 * - `keepBoardBetweenTurns` — Relay. The board is wiped at the top of every
 *   turn; relay is precisely the mode that does not, so it cannot be a number.
 * - `drawerSeesBoard` — Blind. A rendering rule, and one the *server* must
 *   state rather than the client choosing to honour.
 * - `singleColor` — One Colour. Enforced on the stroke, not in the toolbar.
 * - `teams` — Team. Changes what a score belongs to, which nothing else does.
 *
 * Everything else — Speed, Challenge, No Hint, Duo — is entirely expressible
 * as overrides, which is the point of the design.
 */

export const GAME_MODE = {
  classic: 'classic',
  speed: 'speed',
  team: 'team',
  duo: 'duo',
  challenge: 'challenge',
  noHint: 'no_hint',
  oneColor: 'one_color',
  blind: 'blind',
  relay: 'relay',
} as const;

export type GameModeWire = (typeof GAME_MODE)[keyof typeof GAME_MODE];

export const GAME_MODES_LIST = Object.values(GAME_MODE) as GameModeWire[];

/** The settings a mode may override when a match starts. */
export interface ModeSettingOverrides {
  drawTimeSeconds?: number;
  hintCount?: number;
  /** `hidden` withholds even the word length until the first hint. */
  wordMode?: 'normal' | 'hidden';
  /** Narrows the word pool. Absent means the room's own choice stands. */
  wordDifficulty?: 'easy' | 'medium' | 'hard';
}

export interface GameModeDefinition {
  key: GameModeWire;
  name: string;
  description: string;

  /** How many players the mode needs, and will take. */
  minPlayers: number;
  maxPlayers: number;

  /** Applied over the room's settings when the match starts. */
  overrides: ModeSettingOverrides;

  /**
   * Multiplier on every point awarded in this mode.
   *
   * Compensates for difficulty rather than rewarding mode choice: a mode that
   * gives guessers less to work with pays more, so no mode is the obvious one
   * to farm. Applied by the scoring service, so it reaches guesser and drawer
   * points alike.
   */
  scoreMultiplier: number;

  /** Relay: the next drawer continues the last drawing. */
  keepBoardBetweenTurns: boolean;
  /** Blind: the drawer's own strokes are hidden from them. */
  drawerSeesBoard: boolean;
  /** One Colour: every stroke of a turn must use the drawer's first colour. */
  singleColor: boolean;
  /** Team: players are split into sides and score together. */
  teams: boolean;

  /**
   * Whether results count towards the global leaderboard and lifetime stats.
   *
   * False for the modes whose scoring is not comparable with Classic's —
   * Team, where a score belongs to a side, and Duo, where two players split a
   * pot four would share. They still pay XP, because XP measures time played
   * rather than skill; see `XP_AWARDS`.
   */
  ranked: boolean;
}

/**
 * The catalogue.
 *
 * `maxPlayers` never exceeds the room ceiling in `ROOM_LIMITS`; where a mode
 * is tighter than the room, the mode wins — that is what makes Duo a duo.
 */
export const GAME_MODES: readonly GameModeDefinition[] = [
  {
    key: GAME_MODE.classic,
    name: 'Classic',
    description: 'Draw and guess, the usual way.',
    minPlayers: 2,
    maxPlayers: 12,
    overrides: {},
    scoreMultiplier: 1,
    keepBoardBetweenTurns: false,
    drawerSeesBoard: true,
    singleColor: false,
    teams: false,
    ranked: true,
  },
  {
    key: GAME_MODE.speed,
    name: 'Speed',
    description: 'Half the time, one hint, same points.',
    minPlayers: 2,
    maxPlayers: 12,
    // Short enough to feel urgent, long enough to draw something. The hint
    // count drops with the clock — two hints in forty seconds is most of the
    // word.
    overrides: { drawTimeSeconds: 40, hintCount: 1 },
    scoreMultiplier: 1.1,
    keepBoardBetweenTurns: false,
    drawerSeesBoard: true,
    singleColor: false,
    teams: false,
    ranked: true,
  },
  {
    key: GAME_MODE.team,
    name: 'Team',
    description: 'Two sides. Your points go to your team.',
    // Four so each side has a pair; below that "team" is just Classic with
    // extra bookkeeping.
    minPlayers: 4,
    maxPlayers: 12,
    overrides: {},
    scoreMultiplier: 1,
    keepBoardBetweenTurns: false,
    drawerSeesBoard: true,
    singleColor: false,
    teams: true,
    ranked: false,
  },
  {
    key: GAME_MODE.duo,
    name: 'Duo',
    description: 'Just the two of you, taking turns.',
    minPlayers: 2,
    maxPlayers: 2,
    overrides: {},
    scoreMultiplier: 1,
    keepBoardBetweenTurns: false,
    drawerSeesBoard: true,
    singleColor: false,
    teams: false,
    ranked: false,
  },
  {
    key: GAME_MODE.challenge,
    name: 'Challenge',
    description: 'Hard words only.',
    minPlayers: 2,
    maxPlayers: 12,
    overrides: { wordDifficulty: 'hard' },
    // The word pool is the whole difficulty, and the scoring service already
    // pays a hard-word multiplier — so this stays 1 rather than paying twice.
    scoreMultiplier: 1,
    keepBoardBetweenTurns: false,
    drawerSeesBoard: true,
    singleColor: false,
    teams: false,
    ranked: true,
  },
  {
    key: GAME_MODE.noHint,
    name: 'No Hint',
    description: 'No letters, no word length. Read the drawing.',
    minPlayers: 2,
    maxPlayers: 12,
    overrides: { hintCount: 0, wordMode: 'hidden' },
    scoreMultiplier: 1.25,
    keepBoardBetweenTurns: false,
    drawerSeesBoard: true,
    singleColor: false,
    teams: false,
    ranked: true,
  },
  {
    key: GAME_MODE.oneColor,
    name: 'One Colour',
    description: 'The drawer gets one colour for the whole turn.',
    minPlayers: 2,
    maxPlayers: 12,
    overrides: {},
    scoreMultiplier: 1.15,
    keepBoardBetweenTurns: false,
    drawerSeesBoard: true,
    singleColor: true,
    teams: false,
    ranked: true,
  },
  {
    key: GAME_MODE.blind,
    name: 'Blind Drawing',
    description: 'The drawer cannot see what they have drawn.',
    minPlayers: 2,
    maxPlayers: 12,
    // More time, because drawing blind is slow, and a full hint budget
    // because the guessers are reading something barely legible.
    overrides: { drawTimeSeconds: 100 },
    scoreMultiplier: 1.4,
    keepBoardBetweenTurns: false,
    drawerSeesBoard: false,
    singleColor: false,
    teams: false,
    ranked: true,
  },
  {
    key: GAME_MODE.relay,
    name: 'Relay',
    description: 'Each drawer adds to the picture before them.',
    // Three, so a relay is actually a relay rather than two people alternating.
    minPlayers: 3,
    maxPlayers: 12,
    overrides: { drawTimeSeconds: 50 },
    scoreMultiplier: 1.2,
    keepBoardBetweenTurns: true,
    drawerSeesBoard: true,
    singleColor: false,
    teams: false,
    ranked: true,
  },
] as const;

/** The catalogue, indexed. */
export const GAME_MODES_BY_KEY: ReadonlyMap<GameModeWire, GameModeDefinition> = new Map(
  GAME_MODES.map((mode) => [mode.key, mode]),
);

/**
 * The rules for [key], falling back to Classic.
 *
 * Never throws. A mode name this server does not recognise — a client from a
 * later release, or a room stored before a mode was retired — plays Classic
 * rather than failing to start, which is the same forward-compatibility rule
 * the drawing tools follow.
 */
export function modeRules(key: string | null | undefined): GameModeDefinition {
  const found = GAME_MODES_BY_KEY.get(key as GameModeWire);
  return found ?? GAME_MODES_BY_KEY.get(GAME_MODE.classic)!;
}

/** The default mode a room is created in. */
export const DEFAULT_GAME_MODE: GameModeWire = GAME_MODE.classic;

/** Which team a player is on. Only meaningful in a `teams` mode. */
export const TEAM = { none: 'none', red: 'red', blue: 'blue' } as const;
export type TeamWire = (typeof TEAM)[keyof typeof TEAM];

/** The two sides, in assignment order. */
export const TEAM_SIDES: readonly TeamWire[] = [TEAM.red, TEAM.blue] as const;

/** Sanity: no mode may exceed the room ceiling. */
export const MAX_MODE_PLAYERS = Math.max(...GAME_MODES.map((mode) => mode.maxPlayers));

/** The default room size, for a mode that does not narrow it. */
export const DEFAULT_MAX_PLAYERS = ROOM_DEFAULTS.maxPlayers;
