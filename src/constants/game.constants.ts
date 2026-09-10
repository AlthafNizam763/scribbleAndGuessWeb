/**
 * Every tunable number of the game loop.
 *
 * These mirror `lib/core/constants/game_defaults.dart` and
 * `lib/core/rules/scoring.dart` in the Flutter client. The client only uses
 * its copy to render predictions and to run offline practice mode; the values
 * here are the authoritative ones, because the server is the only thing that
 * may decide a score, a deadline or a phase (brief section 52).
 */

/** Default room settings, matching `RoomSettings.defaults` on the client. */
export const ROOM_DEFAULTS = {
  maxPlayers: 8,
  rounds: 3,
  drawTimeSeconds: 80,
  wordChoiceCount: 3,
  hintCount: 2,
  wordSelectSeconds: 15,
  allowVoteKick: true,
  isPrivate: false,
} as const;

/** Inclusive bounds every settings payload is validated against. */
export const ROOM_LIMITS = {
  maxPlayers: { min: 2, max: 12 },
  rounds: { min: 1, max: 10 },
  drawTimeSeconds: { min: 30, max: 180 },
  wordChoiceCount: { min: 2, max: 5 },
  hintCount: { min: 0, max: 5 },
  wordSelectSeconds: { min: 5, max: 30 },
  customWords: { minCount: 5, minLength: 2, maxLength: 24 },
} as const;

/** Phase timing, in seconds unless the name says otherwise. */
export const TIMING = {
  /** Countdown shown between "start" and the first word choice. */
  startCountdownSeconds: 3,
  /** How long the round scoreboard stays up. */
  roundEndSeconds: 6,
  /** How long the final standings stay up before the room reopens. */
  gameEndSeconds: 15,
  /**
   * Slack added to every server deadline before it is enforced.
   *
   * A guess that left the device before the buzzer can still arrive after it;
   * refusing it would punish the player for their own latency.
   */
  turnGraceMs: 400,
  /** How long the turn runs on after the last guesser gets it. */
  allGuessedGraceSeconds: 3,
  /** Fraction of the turn at which the first hint is revealed. */
  firstHintAtFraction: 0.45,
  /** Fraction of the turn by which every hint has been revealed. */
  lastHintAtFraction: 0.85,
  /** How often the authoritative clock is broadcast. */
  timeSyncIntervalMs: 20_000,
  /**
   * How long a disconnected player keeps their seat, score and correct-guess
   * status before the room forgets them (brief section 38).
   */
  reconnectGraceMs: 45_000,
  /**
   * Extra grace given specifically to a disconnected *drawer* before the turn
   * is handed to somebody else (brief section 39).
   */
  drawerReconnectGraceMs: 12_000,
  /** How long an empty room lingers before it is closed and swept. */
  emptyRoomTtlMs: 120_000,
  /** How often the sweeper looks for dead rooms. */
  sweepIntervalMs: 30_000,
  /** How long a vote-kick poll stays open. */
  voteKickWindowMs: 30_000,
} as const;

/** Minimum seated players before the host may start (brief section 18). */
export const MIN_PLAYERS_TO_START = 2;

/**
 * Scoring weights.
 *
 * Mirrors `ScoringConfig.standard` in the Flutter client exactly, so the
 * points the client predicts are the points the server awards. Every value is
 * overridable from the environment, which is what makes the formula
 * "configurable" in the sense of brief section 33.
 */
export const SCORING = {
  /** Points for guessing the instant the turn begins. */
  maxGuessPoints: 100,
  /** Floor for guessing as the buzzer sounds. */
  minGuessPoints: 30,
  /** Bonus for being the first, second and third correct guesser. */
  firstGuessBonus: 25,
  secondGuessBonus: 15,
  thirdGuessBonus: 8,
  /** What the drawer earns per player who got it. */
  drawerPointsPerGuess: 20,
  /** Extra for the drawer when the whole room gets it. */
  drawerAllGuessedBonus: 30,
  /** Ceiling on a single turn's drawer payout. */
  drawerMaxPoints: 120,
  /** Multiplier applied to both guesser and drawer points by difficulty. */
  difficultyMultiplier: { easy: 1.0, medium: 1.15, hard: 1.35 },
} as const;

/** A guess this close to the word is reported as "close", never as correct. */
export const CLOSE_GUESS_MIN_LENGTH = 4;

/** Room code shape. Ambiguous glyphs (0/O, 1/I) are left out on purpose. */
export const ROOM_CODE = {
  length: 5,
  alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
} as const;

/** Input ceilings shared with the client's `AppConstants`. */
export const INPUT_LIMITS = {
  minNameLength: 2,
  maxNameLength: 16,
  maxChatLength: 120,
  maxReportLength: 120,
  avatarCount: 18,
  avatarColorCount: 8,
  /** Hard cap on a board, so a griefer cannot exhaust server memory. */
  maxStrokesPerBoard: 4000,
  /** Hard cap on the points in one stroke. */
  maxPointsPerStroke: 2000,
  /** Hard cap on the points in a single `c:draw:append` batch. */
  maxPointsPerBatch: 200,
  /** How many chat lines are kept in memory per room. */
  chatHistoryLimit: 200,
} as const;
