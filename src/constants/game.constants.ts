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
  /** Whether guessers may talk to each other. The drawer never can. */
  voiceEnabled: true,
  /** Whether the text channel is open. Guesses are never affected. */
  chatEnabled: true,
  /** Which rule set the match runs under. */
  gameMode: 'classic',
  /** Whether people may watch once the seats are full. */
  allowSpectators: true,
  /** Whether only the host's friends may join by code. */
  friendsOnly: false,
  /** Narrows the word pool. Null means the mode or the room decides. */
  wordDifficulty: null,
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
   * The same grace, inside a tournament bracket match.
   *
   * ## Why a bracket match is less patient than an ordinary room
   *
   * Because of who is waiting. In a casual room a disconnected player costs
   * nobody anything — the round carries on with whoever is left, and a long
   * grace is a kindness to somebody on a train. In a bracket match there are
   * two players, so one of them dropping means the *other* is sitting in a
   * frozen duel; and behind that match is a bracket, and behind the bracket a
   * tournament, all of which stop until this resolves.
   *
   * Fifteen seconds covers the thing that actually happens — an app
   * backgrounded at a traffic light, a wifi-to-cellular handover — and
   * anything longer is not a blip. Past it the seat is taken over by a bot so
   * the opponent gets a real game rather than a staring contest; see
   * `tournamentStandInService`.
   */
  tournamentReconnectGraceMs: 15_000,
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
  /**
   * How long a room invitation stays answerable.
   *
   * Long enough to be seen on a phone that was face-down, short enough that
   * the room it names is plausibly still the room described in it. Past this
   * the invitation is refused with `Invitation expired` rather than dropping
   * the invitee into a game that has moved on without them.
   */
  invitationTtlMs: 10 * 60 * 1000,
  /** How often lapsed invitations are swept into the `expired` status. */
  invitationSweepIntervalMs: 60_000,
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
  /** How many recent messages a live room keeps addressable for reactions. */
  chatIndexLimit: 80,
  /** How long a typing indicator stands before the client forgets it. */
  typingTtlMs: 4000,
} as const;

/**
 * Bounds on what a turn's replay may cost to store and to send.
 *
 * ## Why the live limits are not enough
 *
 * `maxStrokesPerBoard` and `maxPointsPerStroke` bound what one *room* can hold
 * in memory while a turn runs, and they are generous because the board is
 * transient — it is thrown away when the turn ends. The snapshot is the
 * opposite: it is written to Mongo, kept for the life of the match, and read
 * back in full by every client that opens a replay. At the live ceiling a
 * single turn could persist four thousand strokes of two thousand points, and
 * a twelve-turn match would be measured in tens of megabytes of documents
 * nobody could load.
 *
 * ## What is given up when a drawing is over budget
 *
 * Points, never strokes. Dropping a stroke removes something the drawer drew;
 * dropping every other *point within* a stroke removes only smoothness, and
 * the replay's curve-smoothing puts most of that back. So compaction thins
 * long strokes and leaves the drawing's content intact — see
 * `replay.service.ts`.
 */
export const REPLAY_LIMITS = {
  /**
   * Total points kept across a whole turn's snapshot.
   *
   * Sized from what a turn can realistically contain: eighty seconds of
   * continuous drawing at the client's sampling rate is a few thousand points,
   * so a normal drawing is never touched. Only the outliers are.
   */
  maxPointsPerSnapshot: 12_000,
  /** Points kept in any one stroke of a snapshot, before the global budget. */
  maxPointsPerStroke: 600,
  /**
   * Strokes kept in a snapshot.
   *
   * Far below the live ceiling, and the one limit that *does* discard content —
   * so it is set where no human drawing reaches it. A turn with more than this
   * is a script, and the replay keeps the earliest strokes rather than a
   * random slice so what it shows is still a drawing in progress.
   */
  maxStrokesPerSnapshot: 1_200,
  /**
   * The longest gap a replay will sit through between two strokes, in ms.
   *
   * A drawer who stops to think for twenty seconds should not make everybody
   * watching the replay wait twenty seconds. Gaps longer than this are shown
   * as this.
   */
  maxIdleGapMs: 1_200,
} as const;
